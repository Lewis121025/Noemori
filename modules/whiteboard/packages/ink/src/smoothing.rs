use crate::validation::{checked_point, increasing_time, non_negative, positive, sample};
use crate::{InkError, Point, StrokeSample};

/// One Euro 滤波配置；频率为 Hz，坐标不隐式换算。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SmoothingOptions {
    /// 低速截止频率，默认 1 Hz；越低越平滑，跟随延迟也越大。
    pub min_cutoff: f64,
    /// 速度自适应系数，默认 0.02，单位为 Hz /（坐标单位/秒）；零表示固定低通。
    pub beta: f64,
    /// 速度估计的截止频率，默认 1 Hz。
    pub derivative_cutoff: f64,
    /// 相邻采样超过此间隔时重置滤波，默认 120 毫秒。
    pub reset_gap_ms: f64,
}

impl Default for SmoothingOptions {
    fn default() -> Self {
        Self {
            min_cutoff: 1.0,
            beta: 0.02,
            derivative_cutoff: 1.0,
            reset_gap_ms: 120.0,
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct State {
    time_ms: f64,
    position: Point,
    velocity: Point,
}

/// 单笔自适应平滑器；二维速度共享截止频率，避免方向改变滤波响应。
#[derive(Debug, Default)]
pub struct OneEuroSmoother {
    options: SmoothingOptions,
    state: Option<State>,
}

fn alpha(dt: f64, cutoff: f64) -> f64 {
    dt / (dt + 1.0 / (std::f64::consts::TAU * cutoff))
}

fn blend(previous: Point, next: Point, amount: f64) -> Result<Point, InkError> {
    checked_point(
        previous.x + amount * (next.x - previous.x),
        previous.y + amount * (next.y - previous.y),
    )
}

impl OneEuroSmoother {
    /// 创建使用指定配置的独立实例，不共享历史。
    ///
    /// # Errors
    /// 配置不是有限值、频率或重置间隔非正数、beta 为负数时返回错误。
    pub fn new(options: SmoothingOptions) -> Result<Self, InkError> {
        positive(options.min_cutoff, "最低截止频率")?;
        non_negative(options.beta, "自适应系数")?;
        positive(options.derivative_cutoff, "速度滤波频率")?;
        positive(options.reset_gap_ms, "暂停重置间隔")?;
        Ok(Self {
            options,
            state: None,
        })
    }

    /// 接收严格递增的真实采样，返回平滑位置；时间与压感保持不变。
    /// 长暂停后的首点保持原位置。所有计算成功后才提交内部状态。
    ///
    /// # Errors
    /// 非法采样、时间重复或倒退、算术溢出时返回错误，且不改变已有状态。
    pub fn push(&mut self, input: StrokeSample) -> Result<StrokeSample, InkError> {
        sample(input)?;
        increasing_time(input.time_ms, self.state.map(|s| s.time_ms))?;
        let next = match self.state {
            Some(previous) if input.time_ms - previous.time_ms <= self.options.reset_gap_ms => {
                self.advance(previous, input)?
            }
            _ => State {
                time_ms: input.time_ms,
                position: input.position,
                velocity: Point { x: 0.0, y: 0.0 },
            },
        };
        self.state = Some(next);
        Ok(StrokeSample {
            position: next.position,
            ..input
        })
    }

    /// 抬笔、取消或切换输入源时清空历史，下一笔允许使用新的时钟起点。
    pub fn reset(&mut self) {
        self.state = None;
    }

    fn advance(&self, previous: State, input: StrokeSample) -> Result<State, InkError> {
        let dt = (input.time_ms - previous.time_ms) / 1000.0;
        // 跟随作者 2023 年修订的参考公式，以当前观测相对上一滤波位置估计变化率。
        // 二维使用共同速度范数，保留旋转等变性，不逐轴采用不同截止频率。
        let derivative = checked_point(
            (input.position.x - previous.position.x) / dt,
            (input.position.y - previous.position.y) / dt,
        )?;
        let velocity = blend(
            previous.velocity,
            derivative,
            alpha(dt, self.options.derivative_cutoff),
        )?;
        let cutoff = self.options.min_cutoff + self.options.beta * velocity.x.hypot(velocity.y);
        positive(cutoff, "自适应截止频率")?;
        Ok(State {
            time_ms: input.time_ms,
            velocity,
            position: blend(previous.position, input.position, alpha(dt, cutoff))?,
        })
    }
}
