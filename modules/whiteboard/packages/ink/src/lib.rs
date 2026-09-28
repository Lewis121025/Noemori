//! 独立的笔迹预测与修正内核。
//!
//! 不依赖 UI、文件系统、平台事件、模型或其他业务包。所有坐标采用调用方统一的
//! 单位，时间采用毫秒。真实采样与预测是不同类型；几何修正只返回候选，不改写输入。

mod correction;
mod geometry;
mod prediction;
mod smoothing;
mod snapping;
mod types;
mod validation;

pub use correction::correct_stroke;
pub use geometry::{fit_circle, fit_line, fit_rectangle};
pub use prediction::{PredictionOptions, StrokePredictor};
pub use smoothing::{OneEuroSmoother, SmoothingOptions};
pub use snapping::{snap_axes, snap_point, Axis, AxisGuide, AxisSnap, PointSnap, SnapTarget};
pub use types::{
    Circle, CorrectionOptions, Fit, Geometry, InkError, Line, Point, Rectangle, Shape,
    StrokeCorrection, StrokePrediction, StrokeSample,
};
