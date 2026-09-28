use std::fmt;

/// 二维位置；距离和误差使用同一输入坐标单位。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Point {
    /// 横坐标。
    pub x: f64,
    /// 纵坐标。
    pub y: f64,
}

/// 真实采样；单笔内时间严格递增，数值在算法入口统一校验。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StrokeSample {
    /// 真实采样位置。
    pub position: Point,
    /// 非负毫秒时间，可使用相对时钟或 epoch 时钟。
    pub time_ms: f64,
    /// 可选的真实压感，范围为 [0, 1]。
    pub pressure: Option<f64>,
}

/// 临时预测；独立类型防止误作为真实采样回灌，不包含虚构压感。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StrokePrediction {
    /// 临时预测位置，不应直接写入永久笔迹。
    pub position: Point,
    /// 预测所依据的最后真实采样时刻。
    pub source_time_ms: f64,
    /// 预测目标时刻。
    pub time_ms: f64,
}

/// 有限线段；方向跟随输入首尾的总体走势。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Line {
    /// 沿笔迹走势的起点。
    pub start: Point,
    /// 沿笔迹走势的终点。
    pub end: Point,
}

/// 支撑圆；不表示原笔迹已经闭合，不负责补全缺失圆弧。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Circle {
    /// 圆心。
    pub center: Point,
    /// 正半径，单位与输入一致。
    pub radius: f64,
}

/// 旋转矩形；尺寸按局部坐标轴解释。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rectangle {
    /// 矩形中心。
    pub center: Point,
    /// 沿局部 x 轴的宽度。
    pub width: f64,
    /// 沿局部 y 轴的高度。
    pub height: f64,
    /// 局部 x 轴相对输入 x 轴的旋转角，单位为弧度。
    pub angle: f64,
}

/// 显式指定的修正目标；不把几何匹配当作文字或图形的语义判断。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shape {
    /// 有限直线段。
    Line,
    /// 支撑圆。
    Circle,
    /// 旋转矩形边界。
    Rectangle,
}

/// 修正产生的具体几何。
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Geometry {
    /// 线段参数。
    Line(Line),
    /// 圆参数。
    Circle(Circle),
    /// 矩形参数。
    Rectangle(Rectangle),
}

/// 拟合结果；误差由全部原始采样计算，不只检查求解用的子集。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Fit<G> {
    /// 拟合得到的几何。
    pub geometry: G,
    /// 点到几何边界的均方根距离。
    pub rms_deviation: f64,
    /// 单点最大偏差，使用输入坐标单位。
    pub max_deviation: f64,
}

impl<G> Fit<G> {
    pub(crate) fn map(self, convert: impl FnOnce(G) -> Geometry) -> Fit<Geometry> {
        Fit {
            geometry: convert(self.geometry),
            rms_deviation: self.rms_deviation,
            max_deviation: self.max_deviation,
        }
    }
}

/// 几何修正的目标与硬限制。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CorrectionOptions {
    /// 调用方明确指定的目标形状。
    pub shape: Shape,
    /// 每个原始点允许的最大位移；不能以低平均误差放过局部大改动。
    pub max_deviation: f64,
}

/// 逐点修正候选；保留原采样数量和顺序，时间、压感由调用方按下标保留。
#[derive(Debug, Clone, PartialEq)]
pub struct StrokeCorrection {
    /// 候选几何，不隐含自动补笔。
    pub geometry: Geometry,
    /// 与输入一一对应的投影位置。
    pub points: Vec<Point>,
    /// 全量原始点的均方根位移。
    pub rms_deviation: f64,
    /// 全量原始点的最大位移。
    pub max_deviation: f64,
}

/// 输入或算术错误；几何退化用成功返回的 None 表达，与错误区分。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InkError {
    /// 参数或计算结果不是有限值，携带字段名。
    NonFinite(&'static str),
    /// 参数超出允许范围，携带字段名。
    OutOfRange(&'static str),
    /// 单笔采样时间重复或倒退。
    NonIncreasingTime,
}

impl fmt::Display for InkError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NonFinite(name) => write!(f, "{name} 必须为有限数值"),
            Self::OutOfRange(name) => write!(f, "{name} 超出允许范围"),
            Self::NonIncreasingTime => write!(f, "单笔采样时间必须严格递增"),
        }
    }
}

impl std::error::Error for InkError {}
