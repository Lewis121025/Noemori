use crate::validation::{checked_point, finite, increasing_time, non_negative, positive, sample};
use crate::{InkError, Point, StrokePrediction, StrokeSample};
use std::collections::VecDeque;
use std::sync::OnceLock;

mod model;

/// 短时外推预算；所有距离使用输入坐标单位。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PredictionOptions {
    /// 最大预测时距，默认 24 毫秒；超出时返回无预测。
    pub max_horizon_ms: f64,
    /// 相对最后真实位置的最大位移，默认 24。
    pub max_distance: f64,
    /// 有界运动拟合窗口，默认 6 个采样，允许 2 到 64；不足 6 点时只使用线性模型。
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

/// 以真实采样回放误差选择局部一次或二次运动；查询不写回预测，保留停笔与急转向保护。
#[derive(Debug, Default)]
pub struct StrokePredictor {
    options: PredictionOptions,
    samples: VecDeque<StrokeSample>,
    // 模型选择只依赖真实历史。惰性复用避免多个显示帧重复拟合，并保留共享引用的并发查询。
    motion_model: OnceLock<Result<Option<model::MotionModel>, InkError>>,
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
    for _ in 0..4 {
        let length = displacement(position);
        if length <= limit {
            break;
        }
        finite(length, "舍入后的预测位移")?;
        // 必须收缩真实位移：接近世界原点时，对绝对坐标退一个 ULP 可能完全不改变位移。
        // 有界重投影消除方向归一化与乘加的舍入；最终硬预算检查仍不可省略。
        let shrink = (limit / length).next_down().max(0.0);
        position = checked_point(
            origin.x + (position.x - origin.x) * shrink,
            origin.y + (position.y - origin.y) * shrink,
        )?;
    }
    if displacement(position) > limit {
        // 大绝对坐标下若重投影仍落回同一网格点，再向原点退一个可表示值。
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
            motion_model: OnceLock::new(),
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
        self.motion_model.take();
        Ok(())
    }

    /// 查询目标时刻的临时位置；历史不足、过期、停笔、急转向或无法表示有效位移时返回 None。
    /// 结果不包含压感，也不能作为 StrokeSample 传入 push。
    /// 同一真实历史仅选择一次运动模型，改变查询时刻只重新求值，不反馈到采样。
    ///
    /// # Errors
    /// 时刻非法、早于最新采样、数值分解失败或计算溢出时返回错误；查询不修改历史。
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
        let Some(current) = observed_velocity(&self.samples, self.samples.len())? else {
            return Ok(None);
        };
        let selected = self
            .motion_model
            .get_or_init(|| model::select_quadratic_model(&self.samples, self.options))
            .as_ref()
            .map_err(|error| *error)?;
        let curved_offset = match selected {
            Some(model) => model.predict(time_ms)?,
            None => None,
        };
        let offset = if let Some(offset) = curved_offset {
            offset
        } else {
            let Some(v) = linear_velocity(&self.samples, self.samples.len(), current)? else {
                return Ok(None);
            };
            let speed = v.x.hypot(v.y);
            if speed == 0.0 {
                return Ok(None);
            }
            let distance = self.options.max_distance.min(speed * horizon);
            let direction = unit_direction(v);
            Point {
                x: direction.x * distance,
                y: direction.y * distance,
            }
        };
        let length = offset.x.hypot(offset.y);
        finite(length, "预测位移")?;
        if length == 0.0 {
            return Ok(None);
        }
        let Some(position) = bounded_position(
            last.position,
            unit_direction(offset),
            length.min(self.options.max_distance),
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
        self.motion_model.take();
    }
}

fn observed_velocity(
    samples: &VecDeque<StrokeSample>,
    n: usize,
) -> Result<Option<Point>, InkError> {
    let current = velocity(samples[n - 2], samples[n - 1])?;
    let current_speed = current.x.hypot(current.y);
    finite(current_speed, "观测速度")?;
    if current_speed == 0.0 {
        return Ok(None);
    }
    if n >= 3 && !agrees(velocity(samples[n - 3], samples[n - 2])?, current) {
        return Ok(None);
    }
    Ok(Some(current))
}

fn linear_velocity(
    samples: &VecDeque<StrokeSample>,
    count: usize,
    current: Point,
) -> Result<Option<Point>, InkError> {
    let current_speed = current.x.hypot(current.y);
    let fitted = regress_velocity(samples, count)?;
    let speed = fitted.x.hypot(fitted.y);
    finite(speed, "预测速度")?;
    if speed == 0.0 || !agrees(fitted, current) {
        return Ok(None);
    }
    // 减速时不允许较早的高速采样抬高当前外推速度。
    let ratio = (current_speed / speed).min(1.0);
    Ok(Some(checked_point(fitted.x * ratio, fitted.y * ratio)?))
}

fn regress_velocity(samples: &VecDeque<StrokeSample>, count: usize) -> Result<Point, InkError> {
    let first = samples[0];
    let last = samples[count - 1];
    let span = last.time_ms - first.time_ms;
    // 时间移到局部单位区间，避免 epoch 时间平方相消或极短间隔平方下溢。
    let mean = samples
        .iter()
        .take(count)
        .map(|p| (p.time_ms - first.time_ms) / span)
        .sum::<f64>()
        / count as f64;
    let (mut variance, mut x, mut y) = (0.0, 0.0, 0.0);
    for p in samples.iter().take(count) {
        let t = (p.time_ms - first.time_ms) / span - mean;
        variance += t * t;
        x += t * (p.position.x - last.position.x);
        y += t * (p.position.y - last.position.y);
    }
    checked_point(x / variance / span, y / variance / span)
}
