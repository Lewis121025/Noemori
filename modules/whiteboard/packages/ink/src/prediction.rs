use crate::validation::{checked_point, finite, increasing_time, non_negative, positive, sample};
use crate::{InkError, Point, StrokePrediction, StrokeSample};
use std::collections::VecDeque;

/// 短时外推预算；所有距离使用输入坐标单位。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PredictionOptions {
    /// 最大预测时距，默认 24 毫秒；超出时返回无预测。
    pub max_horizon_ms: f64,
    /// 相对最后真实位置的最大位移，默认 24。
    pub max_distance: f64,
    /// 有界回归窗口，默认 6 个采样，允许 2 到 64。
    pub history_size: usize,
    /// 相邻采样超过此间隔时清空旧历史，默认 120 毫秒。
    pub reset_gap_ms: f64,
}

impl Default for PredictionOptions {
    fn default() -> Self {
        Self {
            max_horizon_ms: 24.0,
            max_distance: 24.0,
            history_size: 6,
            reset_gap_ms: 120.0,
        }
    }
}

/// 只以真实采样更新的有界预测器；预测查询使用不可变引用，不写回预测结果。
#[derive(Debug, Default)]
pub struct StrokePredictor {
    options: PredictionOptions,
    samples: VecDeque<StrokeSample>,
}

fn unit_direction(vector: Point) -> Point {
    // 调用方已确保向量有限且非零。先缩放，避免次正规数的长度舍入放大单位方向。
    let scale = vector.x.abs().max(vector.y.abs());
    let (x, y) = (vector.x / scale, vector.y / scale);
    let length = x.hypot(y);
    Point {
        x: x / length,
        y: y / length,
    }
}

fn agrees(a: Point, b: Point) -> bool {
    if (a.x == 0.0 && a.y == 0.0) || (b.x == 0.0 && b.y == 0.0) {
        return true;
    }
    let a = unit_direction(a);
    let b = unit_direction(b);
    // 超过 60 度的急转向暂停外推，避免旧速度越过拐角。
    a.x * b.x + a.y * b.y >= 0.5
}

fn step_towards(value: f64, target: f64) -> f64 {
    if value > target {
        value.next_down()
    } else if value < target {
        value.next_up()
    } else {
        value
    }
}

fn bounded_position(
    origin: Point,
    direction: Point,
    distance: f64,
    limit: f64,
) -> Result<Option<Point>, InkError> {
    let mut position = checked_point(
        origin.x + direction.x * distance,
        origin.y + direction.y * distance,
    )?;
    let displacement = |p: Point| (p.x - origin.x).hypot(p.y - origin.y);
    if displacement(position) > limit {
        // 加回绝对坐标可能把已限幅的位移向外舍入；向原点退一个可表示值后再检查。
        position.x = step_towards(position.x, origin.x);
        position.y = step_towards(position.y, origin.y);
    }
    if position == origin || displacement(position) > limit {
        // 当前精度无法给出有效且守约的预测时，不产生原地或超预算的伪预测。
        return Ok(None);
    }
    Ok(Some(position))
}

fn velocity(a: StrokeSample, b: StrokeSample) -> Result<Point, InkError> {
    let dt = b.time_ms - a.time_ms;
    checked_point(
        (b.position.x - a.position.x) / dt,
        (b.position.y - a.position.y) / dt,
    )
}

impl StrokePredictor {
    /// 创建使用指定预测预算的独立实例。
    ///
    /// # Errors
    /// 非正数或非有限预算、超出 [2, 64] 的历史采样数返回错误。
    pub fn new(options: PredictionOptions) -> Result<Self, InkError> {
        positive(options.max_horizon_ms, "最大预测时距")?;
        positive(options.max_distance, "最大预测位移")?;
        positive(options.reset_gap_ms, "暂停重置间隔")?;
        if !(2..=64).contains(&options.history_size) {
            return Err(InkError::OutOfRange("历史采样数"));
        }
        Ok(Self {
            options,
            samples: VecDeque::with_capacity(options.history_size),
        })
    }

    /// 保存真实采样的副本；保留有限历史，长暂停后开始新的预测段。
    ///
    /// # Errors
    /// 采样无效或时间不递增时返回错误，已有历史保持不变。
    pub fn push(&mut self, input: StrokeSample) -> Result<(), InkError> {
        sample(input)?;
        let last = self.samples.back().copied();
        increasing_time(input.time_ms, last.map(|s| s.time_ms))?;
        if last.is_some_and(|s| input.time_ms - s.time_ms > self.options.reset_gap_ms) {
            self.samples.clear();
        }
        if self.samples.len() == self.options.history_size {
            self.samples.pop_front();
        }
        self.samples.push_back(input);
        Ok(())
    }

    /// 查询目标时刻的临时位置；历史不足、过期、停笔、急转向或无法表示有效位移时返回 None。
    /// 结果不包含压感，也不能作为 StrokeSample 传入 push。
    ///
    /// # Errors
    /// 时刻非法、早于最新采样或数值计算溢出时返回错误；查询不修改历史。
    pub fn predict(&self, time_ms: f64) -> Result<Option<StrokePrediction>, InkError> {
        non_negative(time_ms, "预测时刻")?;
        let Some(last) = self.samples.back() else {
            return Ok(None);
        };
        if time_ms < last.time_ms {
            return Err(InkError::OutOfRange("预测时刻早于最新采样"));
        }
        let horizon = time_ms - last.time_ms;
        if self.samples.len() < 2 || horizon == 0.0 || horizon > self.options.max_horizon_ms {
            return Ok(None);
        }
        let Some(v) = self.estimate_velocity()? else {
            return Ok(None);
        };
        let speed = v.x.hypot(v.y);
        if speed == 0.0 {
            return Ok(None);
        }
        let distance = self.options.max_distance.min(speed * horizon);
        let Some(position) = bounded_position(
            last.position,
            unit_direction(v),
            distance,
            self.options.max_distance,
        )?
        else {
            return Ok(None);
        };
        Ok(Some(StrokePrediction {
            position,
            source_time_ms: last.time_ms,
            time_ms,
        }))
    }

    /// 抬笔、取消或切换输入源时清空历史，下一笔允许重置时间起点。
    pub fn reset(&mut self) {
        self.samples.clear();
    }

    fn estimate_velocity(&self) -> Result<Option<Point>, InkError> {
        let n = self.samples.len();
        let current = velocity(self.samples[n - 2], self.samples[n - 1])?;
        let current_speed = current.x.hypot(current.y);
        finite(current_speed, "观测速度")?;
        if current_speed == 0.0 {
            return Ok(None);
        }
        if n >= 3 && !agrees(velocity(self.samples[n - 3], self.samples[n - 2])?, current) {
            return Ok(None);
        }
        let fitted = self.regress_velocity()?;
        let speed = fitted.x.hypot(fitted.y);
        finite(speed, "预测速度")?;
        if speed == 0.0 || !agrees(fitted, current) {
            return Ok(None);
        }
        // 减速时不允许较早的高速采样抬高当前外推速度。
        let ratio = (current_speed / speed).min(1.0);
        Ok(Some(checked_point(fitted.x * ratio, fitted.y * ratio)?))
    }

    fn regress_velocity(&self) -> Result<Point, InkError> {
        let first = self.samples[0];
        let last = self.samples[self.samples.len() - 1];
        let span = last.time_ms - first.time_ms;
        // 时间移到局部单位区间，避免 epoch 时间平方相消或极短间隔平方下溢。
        let mean = self
            .samples
            .iter()
            .map(|p| (p.time_ms - first.time_ms) / span)
            .sum::<f64>()
            / self.samples.len() as f64;
        let (mut variance, mut x, mut y) = (0.0, 0.0, 0.0);
        for p in &self.samples {
            let t = (p.time_ms - first.time_ms) / span - mean;
            variance += t * t;
            x += t * (p.position.x - last.position.x);
            y += t * (p.position.y - last.position.y);
        }
        checked_point(x / variance / span, y / variance / span)
    }
}
