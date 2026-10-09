//! 截图像素与 macOS 屏幕点的映射只依赖实际裁剪范围，不假设主显示器或 Retina 比例。
use serde_json::{Value, json};

/// AX 和 ScreenCaptureKit 的屏幕点范围；负坐标属于正常多显示器布局。
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
impl Bounds {
    pub(crate) fn json(self) -> Value {
        json!({"x":self.x,"y":self.y,"width":self.width,"height":self.height})
    }
}
/// 一张实际截图的尺寸与源范围，窗口移动后由观察代次使映射失效。
#[derive(Clone, Copy)]
pub(crate) struct PixelMapping {
    pub bounds: Bounds,
    pub width: usize,
    pub height: usize,
}
impl PixelMapping {
    /// 接收截图像素点，返回屏幕点；非有限值、空截图或越界坐标均拒绝，不触发输入。
    pub(crate) fn screen_point(self, x: f64, y: f64) -> Result<(f64, f64), String> {
        if self.width == 0
            || self.height == 0
            || self.width > 4096
            || self.height > 4096
            || ![
                self.bounds.x,
                self.bounds.y,
                self.bounds.width,
                self.bounds.height,
                x,
                y,
            ]
            .iter()
            .all(|value| value.is_finite())
            || self.bounds.width <= 0.0
            || self.bounds.height <= 0.0
        {
            return Err("截图坐标映射无效".into());
        }
        if x < 0.0 || y < 0.0 || x >= self.width as f64 || y >= self.height as f64 {
            return Err("截图坐标越界".into());
        }
        Ok((
            self.bounds.x + x / self.width as f64 * self.bounds.width,
            self.bounds.y + y / self.height as f64 * self.bounds.height,
        ))
    }
}
