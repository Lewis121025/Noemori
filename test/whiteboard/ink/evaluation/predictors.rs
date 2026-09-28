//! 仅用于同条件实验的预测器；不进入正式内核，不以真实未来坐标更新状态。
use nalgebra::{Matrix4, SMatrix, Vector4};
use nous_ink::{
    InkError, Point, PredictionOptions, StrokePrediction, StrokePredictor, StrokeSample,
};
use std::collections::VecDeque;

#[path = "../unit/experimental_predictors.rs"]
mod tests;

/// 所有候选接受相同真实事件，并在同一目标时刻返回临时位置。
pub(super) trait Predictor {
    fn push(&mut self, sample: StrokeSample) -> Result<(), InkError>;
    fn predict(&self, time: f64) -> Result<Option<StrokePrediction>, InkError>;
}

impl Predictor for StrokePredictor {
    fn push(&mut self, sample: StrokeSample) -> Result<(), InkError> {
        self.push(sample)
    }
    fn predict(&self, time: f64) -> Result<Option<StrokePrediction>, InkError> {
        self.predict(time)
    }
}

/// 显式列出有限实验，不提供任意运行时算法插件或参数搜索接口。
pub(super) fn create(name: &str) -> Box<dyn Predictor> {
    if let Some(inner) = name.strip_suffix("_guarded") {
        assert!(["kalman16", "kalman32", "kalman64", "androidx_core"].contains(&inner));
        return Box::new(Guarded {
            inner: create(inner),
            samples: VecDeque::new(),
        });
    }
    match name {
        "baseline" => Box::new(StrokePredictor::default()),
        "count12" => Box::new(
            StrokePredictor::new(PredictionOptions {
                history_size: 12,
                ..Default::default()
            })
            .unwrap(),
        ),
        "time32" => Box::new(TimeWindow::new(32.0, 6)),
        "time48" => Box::new(TimeWindow::new(48.0, 6)),
        "time64" => Box::new(TimeWindow::new(64.0, 6)),
        "time48_strict" => Box::new(TimeWindow::new(48.0, 2)),
        "time32_strict" => Box::new(TimeWindow::new(32.0, 2)),
        "time64_strict" => Box::new(TimeWindow::new(64.0, 2)),
        "jerk16" => Box::new(ContinuousKalman::<4>::new(16.0)),
        "jerk32" => Box::new(ContinuousKalman::<4>::new(32.0)),
        "jerk64" => Box::new(ContinuousKalman::<4>::new(64.0)),
        "kalman16" => Box::new(ContinuousKalman::<3>::new(16.0)),
        "kalman32" => Box::new(ContinuousKalman::<3>::new(32.0)),
        "kalman32_noise" => Box::new(ContinuousKalman::<3>::adaptive(false)),
        "kalman32_adaptive" => Box::new(ContinuousKalman::<3>::adaptive(true)),
        "kalman64" => Box::new(ContinuousKalman::<3>::new(64.0)),
        "androidx_core" => Box::new(AndroidCore::default()),
        _ => panic!("未知实验配置：{name}"),
    }
}

/// 将相同的停笔/急转保护用于对照，区分滤波模型效果与外围保护策略效果。
struct Guarded {
    inner: Box<dyn Predictor>,
    samples: VecDeque<StrokeSample>,
}

impl Predictor for Guarded {
    fn push(&mut self, input: StrokeSample) -> Result<(), InkError> {
        self.inner.push(input)?;
        if self
            .samples
            .back()
            .is_some_and(|last| input.time_ms - last.time_ms > 120.0)
        {
            self.samples.clear();
        }
        if self.samples.len() == 3 {
            self.samples.pop_front();
        }
        self.samples.push_back(input);
        Ok(())
    }
    fn predict(&self, time: f64) -> Result<Option<StrokePrediction>, InkError> {
        if horizon(self.samples.back().copied(), time)?.is_none() {
            return Ok(None);
        }
        let n = self.samples.len();
        if n >= 2 {
            let delta = |i: usize| Point {
                x: self.samples[i].position.x - self.samples[i - 1].position.x,
                y: self.samples[i].position.y - self.samples[i - 1].position.y,
            };
            let current = delta(n - 1);
            let speed = current.x.hypot(current.y);
            if speed == 0.0 {
                return Ok(None);
            }
            if n == 3 {
                let previous = delta(1);
                let old = previous.x.hypot(previous.y);
                if old > 0.0
                    && (current.x / speed) * (previous.x / old)
                        + (current.y / speed) * (previous.y / old)
                        < 0.5
                {
                    return Ok(None);
                }
            }
        }
        self.inner.predict(time)
    }
}

/// 改变保留窗口，其余拟合、模型选择、保护规则均调用当前内核，隔离变量。
struct TimeWindow {
    window: f64,
    minimum: usize,
    samples: VecDeque<StrokeSample>,
    kernel: StrokePredictor,
}

impl TimeWindow {
    fn new(window: f64, minimum: usize) -> Self {
        Self {
            window,
            minimum,
            samples: VecDeque::new(),
            kernel: StrokePredictor::default(),
        }
    }
}

impl Predictor for TimeWindow {
    fn push(&mut self, input: StrokeSample) -> Result<(), InkError> {
        validate(input, self.samples.back().copied())?;
        if self
            .samples
            .back()
            .is_some_and(|last| input.time_ms - last.time_ms > 120.0)
        {
            self.samples.clear();
        }
        self.samples.push_back(input);
        while self.samples.len() > 64
            || (self.samples.len() > self.minimum
                && input.time_ms - self.samples[0].time_ms > self.window)
        {
            self.samples.pop_front();
        }
        self.kernel = StrokePredictor::new(PredictionOptions {
            history_size: self.samples.len().max(2),
            ..Default::default()
        })?;
        for sample in &self.samples {
            self.kernel.push(*sample)?;
        }
        Ok(())
    }
    fn predict(&self, time: f64) -> Result<Option<StrokePrediction>, InkError> {
        self.kernel.predict(time)
    }
}

fn validate(input: StrokeSample, last: Option<StrokeSample>) -> Result<(), InkError> {
    if !input.position.x.is_finite() || !input.position.y.is_finite() || !input.time_ms.is_finite()
    {
        return Err(InkError::NonFinite("实验输入"));
    }
    if input.time_ms < 0.0
        || input
            .pressure
            .is_some_and(|p| !p.is_finite() || !(0.0..=1.0).contains(&p))
    {
        return Err(InkError::OutOfRange("实验输入"));
    }
    if last.is_some_and(|last| input.time_ms <= last.time_ms) {
        return Err(InkError::NonIncreasingTime);
    }
    Ok(())
}

fn horizon(last: Option<StrokeSample>, time: f64) -> Result<Option<f64>, InkError> {
    if !time.is_finite() {
        return Err(InkError::NonFinite("实验预测时刻"));
    }
    if time < 0.0 || last.is_some_and(|last| time < last.time_ms) {
        return Err(InkError::OutOfRange("实验预测时刻"));
    }
    Ok(last
        .map(|last| time - last.time_ms)
        .filter(|h| *h > 0.0 && *h <= 24.0))
}

fn bounded(
    last: StrokeSample,
    time: f64,
    offset: Point,
) -> Result<Option<StrokePrediction>, InkError> {
    let length = offset.x.hypot(offset.y);
    if !length.is_finite() {
        return Err(InkError::NonFinite("实验预测位移"));
    }
    if length == 0.0 {
        return Ok(None);
    }
    let ratio = (24.0 / length).min(1.0);
    let mut position = Point {
        x: last.position.x + offset.x * ratio,
        y: last.position.y + offset.y * ratio,
    };
    let displacement = |p: Point| (p.x - last.position.x).hypot(p.y - last.position.y);
    for _ in 0..4 {
        let length = displacement(position);
        if length <= 24.0 {
            break;
        }
        if !length.is_finite() {
            return Err(InkError::NonFinite("实验舍入位移"));
        }
        let shrink = (24.0 / length).next_down().max(0.0);
        position = Point {
            x: last.position.x + (position.x - last.position.x) * shrink,
            y: last.position.y + (position.y - last.position.y) * shrink,
        };
    }
    if displacement(position) > 24.0 {
        // 与内核采用相同的最终舍入保护，避免把不同预算误判为模型质量差异。
        let towards = |value: f64, origin: f64| {
            if value > origin {
                value.next_down()
            } else if value < origin {
                value.next_up()
            } else {
                value
            }
        };
        position.x = towards(position.x, last.position.x);
        position.y = towards(position.y, last.position.y);
    }
    if position == last.position || displacement(position) > 24.0 {
        return Ok(None);
    }
    Ok(Some(StrokePrediction {
        position,
        source_time_ms: last.time_ms,
        time_ms: time,
    }))
}

fn factorial(n: usize) -> f64 {
    (1..=n).fold(1.0, |value, i| value * i as f64)
}

/// 以第三阶差分消除局部二次运动，再用短窗口中位数降低孤立状态变化对噪声估计的影响。
/// 非均匀时间使用 Lagrange 权重；估计含模型失配，不宣称等于真实硬件噪声。
#[derive(Default)]
struct MeasurementNoise {
    samples: VecDeque<StrokeSample>,
    energies: VecDeque<f64>,
}

impl MeasurementNoise {
    fn observe(&mut self, input: StrokeSample) -> f64 {
        if self.samples.len() == 4 {
            self.samples.pop_front();
        }
        self.samples.push_back(input);
        if self.samples.len() == 4 {
            let span = input.time_ms - self.samples[0].time_ms;
            let times: Vec<_> = self
                .samples
                .iter()
                .map(|p| (p.time_ms - input.time_ms) / span)
                .collect();
            let (mut x, mut y, mut squared_weights) = (0.0, 0.0, 1.0);
            for i in 0..3 {
                let weight = (0..3)
                    .filter(|j| *j != i)
                    .map(|j| -times[j] / (times[i] - times[j]))
                    .product::<f64>();
                x -= weight * (self.samples[i].position.x - input.position.x);
                y -= weight * (self.samples[i].position.y - input.position.y);
                squared_weights += weight * weight;
            }
            if self.energies.len() == 9 {
                self.energies.pop_front();
            }
            self.energies
                .push_back((x * x + y * y) / (2.0 * squared_weights));
        }
        if self.energies.len() < 5 {
            return 1.0;
        }
        let mut values: Vec<_> = self.energies.iter().copied().collect();
        values.sort_by(f64::total_cmp);
        let middle = values.len() / 2;
        let median = if values.len() % 2 == 0 {
            (values[middle - 1] + values[middle]) / 2.0
        } else {
            values[middle]
        };
        median / std::f64::consts::LN_2
    }
}

/// 三维匀加速度与四维匀 jerk 的连续时间 Kalman；F/Q 使用真实 dt，Joseph 形式更新协方差。
/// q 使经过 tau 后过程噪声的位置方差等于测量方差；不假设设备均匀采样。
struct ContinuousKalman<const N: usize> {
    tau: f64,
    state: SMatrix<f64, N, 2>,
    covariance: SMatrix<f64, N, N>,
    last: Option<StrokeSample>,
    count: usize,
    noise: Option<MeasurementNoise>,
    adapt_velocity: bool,
}

impl<const N: usize> ContinuousKalman<N> {
    fn process_noise(&self, dt: f64) -> SMatrix<f64, N, N> {
        let order = 2 * N - 1;
        let q = factorial(N - 1).powi(2) * order as f64 / self.tau.powi(order as i32);
        SMatrix::from_fn(|i, j| {
            let power = order - i - j;
            q * dt.powi(power as i32) / (factorial(N - 1 - i) * factorial(N - 1 - j) * power as f64)
        })
    }
    fn new(tau: f64) -> Self {
        Self {
            tau,
            state: SMatrix::zeros(),
            covariance: SMatrix::zeros(),
            last: None,
            count: 0,
            noise: None,
            adapt_velocity: false,
        }
    }

    fn adaptive(adapt_velocity: bool) -> Self {
        Self {
            noise: Some(MeasurementNoise::default()),
            adapt_velocity,
            ..Self::new(32.0)
        }
    }
}

impl<const N: usize> Predictor for ContinuousKalman<N> {
    fn push(&mut self, input: StrokeSample) -> Result<(), InkError> {
        validate(input, self.last)?;
        if self
            .last
            .is_none_or(|last| input.time_ms - last.time_ms > 120.0)
        {
            let tau = self.tau;
            let adaptive = self.noise.is_some();
            let adapt_velocity = self.adapt_velocity;
            *self = Self::new(tau);
            if adaptive {
                self.noise = Some(MeasurementNoise::default());
            }
            self.adapt_velocity = adapt_velocity;
            if let Some(noise) = &mut self.noise {
                noise.observe(input);
            }
            self.state[(0, 0)] = input.position.x;
            self.state[(0, 1)] = input.position.y;
            self.last = Some(input);
            self.count = 1;
            return Ok(());
        }
        let last = self.last.unwrap();
        let dt = input.time_ms - last.time_ms;
        let measurement_variance = self
            .noise
            .as_mut()
            .map_or(1.0, |noise| noise.observe(input));
        if self.count == 1 {
            self.state[(0, 0)] = input.position.x;
            self.state[(0, 1)] = input.position.y;
            self.state[(1, 0)] = (input.position.x - last.position.x) / dt;
            self.state[(1, 1)] = (input.position.y - last.position.y) / dt;
            self.covariance = SMatrix::zeros();
            self.covariance[(0, 0)] = 1.0;
            self.covariance[(0, 1)] = 1.0 / dt;
            self.covariance[(1, 0)] = 1.0 / dt;
            self.covariance[(1, 1)] = 2.0 / (dt * dt);
            let prior = self.process_noise(self.tau);
            for i in 2..N {
                for j in 2..N {
                    self.covariance[(i, j)] = prior[(i, j)];
                }
            }
        } else {
            let f = SMatrix::<f64, N, N>::from_fn(|i, j| {
                if j >= i {
                    dt.powi((j - i) as i32) / factorial(j - i)
                } else {
                    0.0
                }
            });
            let q = self.process_noise(dt);
            self.state = f * self.state;
            self.covariance = f * self.covariance * f.transpose() + q;
            let innovation = SMatrix::<f64, 1, 2>::new(
                input.position.x - self.state[(0, 0)],
                input.position.y - self.state[(0, 1)],
            );
            if self.adapt_velocity {
                // χ²(2, 0.99) 仅用作实验中的失配门限；沿速度跳变方向增加不确定性，不伪造真值标签。
                let extra = (innovation.norm_squared() / 9.210340371976184
                    - self.covariance[(0, 0)]
                    - measurement_variance)
                    .max(0.0);
                let jump = SMatrix::<f64, N, 1>::from_fn(|i, _| match i {
                    0 => 1.0,
                    1 => 1.0 / dt,
                    _ => 0.0,
                });
                self.covariance += jump * jump.transpose() * extra;
            }
            let gain = self.covariance.column(0) / (self.covariance[(0, 0)] + measurement_variance);
            self.state += gain * innovation;
            let measurement = SMatrix::<f64, 1, N>::from_fn(|_, j| if j == 0 { 1.0 } else { 0.0 });
            let residual = SMatrix::<f64, N, N>::identity() - gain * measurement;
            self.covariance = residual * self.covariance * residual.transpose()
                + gain * gain.transpose() * measurement_variance;
        }
        self.last = Some(input);
        self.count += 1;
        Ok(())
    }
    fn predict(&self, time: f64) -> Result<Option<StrokePrediction>, InkError> {
        let Some(h) = horizon(self.last, time)? else {
            return Ok(None);
        };
        if self.count < 2 {
            return Ok(None);
        }
        bounded(
            self.last.unwrap(),
            time,
            Point {
                x: (1..N)
                    .map(|i| self.state[(i, 0)] * h.powi(i as i32) / factorial(i))
                    .sum(),
                y: (1..N)
                    .map(|i| self.state[(i, 1)] * h.powi(i as i32) / factorial(i))
                    .sum(),
            },
        )
    }
}

/// AndroidX 四维滤波核心的 f64 适配；来源及修改列在 androidx-provenance.json。
/// 保留上游 F/Q/R、初始协方差和 jerk 限制；查询改为无状态，按实际目标时刻插值。
#[derive(Default)]
struct AndroidCore {
    state: SMatrix<f64, 4, 2>,
    covariance: Matrix4<f64>,
    last: Option<StrokeSample>,
    count: usize,
    intervals: usize,
    interval_sum: f64,
}

impl Predictor for AndroidCore {
    fn push(&mut self, input: StrokeSample) -> Result<(), InkError> {
        validate(input, self.last)?;
        if self
            .last
            .is_none_or(|last| input.time_ms - last.time_ms > 120.0)
        {
            *self = Self::default();
            self.covariance = Matrix4::identity();
            self.state[(0, 0)] = input.position.x;
            self.state[(0, 1)] = input.position.y;
        } else {
            let dt = input.time_ms - self.last.unwrap().time_ms;
            if self.intervals < 20 {
                self.interval_sum += dt;
                self.intervals += 1;
            }
            let f = Matrix4::new(
                1.0, 1.0, 0.5, 0.16, 0.0, 1.0, 1.0, 0.5, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 1.0,
            );
            let g = Vector4::new(0.16, 0.5, 1.0, 1.0);
            self.state = f * self.state;
            self.covariance = f * self.covariance * f.transpose() + g * g.transpose() * 0.01;
            let gain = self.covariance.column(0) / (self.covariance[(0, 0)] + 1.0);
            self.state += gain
                * SMatrix::<f64, 1, 2>::new(
                    input.position.x - self.state[(0, 0)],
                    input.position.y - self.state[(0, 1)],
                );
            let residual =
                Matrix4::identity() - gain * Vector4::new(1.0, 0.0, 0.0, 0.0).transpose();
            self.covariance =
                residual * self.covariance * residual.transpose() + gain * gain.transpose();
        }
        self.last = Some(input);
        self.count += 1;
        Ok(())
    }
    fn predict(&self, time: f64) -> Result<Option<StrokePrediction>, InkError> {
        let Some(h) = horizon(self.last, time)? else {
            return Ok(None);
        };
        if self.count < 4 || self.intervals == 0 {
            return Ok(None);
        }
        let rate = self.interval_sum / self.intervals as f64;
        let jerk = self.state[(3, 0)].hypot(self.state[(3, 1)]);
        // 采用上游非手指工具阈值；数据无工具标签，因此不能声称这是设备原生效果。
        let confidence = 1.0 - ((jerk - 0.1) / 0.1).clamp(0.0, 1.0);
        let steps = (h / rate * confidence).ceil();
        if steps == 0.0 {
            return Ok(None);
        }
        let target = (h / rate).min(steps);
        let mut offset = [0.0; 2];
        for (axis, offset) in offset.iter_mut().enumerate() {
            let (v, a, j) = (
                self.state[(1, axis)],
                self.state[(2, axis)],
                self.state[(3, axis)] * f64::from(0.1_f32),
            );
            // 上游逐步累加的闭式形式，查询成本不随极端时距/报告间隔比值增长。
            let n = target.floor();
            *offset = n * v + a * n * (n + 1.0) / 4.0 + j * n * (n + 1.0) * (n + 2.0) / 12.0;
            *offset += (target - n) * (v + a * (n + 1.0) / 2.0 + j * (n + 1.0) * (n + 2.0) / 4.0);
        }
        bounded(
            self.last.unwrap(),
            time,
            Point {
                x: offset[0],
                y: offset[1],
            },
        )
    }
}
