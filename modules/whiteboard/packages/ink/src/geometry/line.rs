use super::shared::{measure, normalize};
use crate::{Fit, InkError, Line, Point};

/// 正交最小二乘拟合有限线段，兼容垂直线；方向由有界原始位置子集估计。
/// 返回几何及全部采样的误差；位置不足或数值退化时返回 None，不修改输入。
///
/// # Errors
/// 坐标不是有限值、跨度或计算结果溢出时返回错误。
pub fn fit_line(points: &[Point]) -> Result<Option<Fit<Line>>, InkError> {
    let Some(frame) = normalize(points)? else {
        return Ok(None);
    };
    let n = frame.samples.len() as f64;
    let mean_x = frame.samples.iter().map(|p| p.x).sum::<f64>() / n;
    let mean_y = frame.samples.iter().map(|p| p.y).sum::<f64>() / n;
    let (mut xx, mut xy, mut yy) = (0.0, 0.0, 0.0);
    for p in &frame.samples {
        let (x, y) = (p.x - mean_x, p.y - mean_y);
        xx += x * x;
        xy += x * y;
        yy += y * y;
    }
    // 直接求主特征向量，避免 atan2/sin_cos 把精确竖线变成带横向误差的斜线。
    // 选取相加的一侧构造向量，避免近轴方向发生相近数相减。
    let half_difference = (xx - yy) / 2.0;
    let radius = half_difference.hypot(xy);
    let (x, y) = if half_difference >= 0.0 {
        (radius + half_difference, xy)
    } else {
        (xy, radius - half_difference)
    };
    let length = x.hypot(y);
    // 各方向方差完全相同时没有唯一主轴，稳定选择 x 轴。
    let (mut dx, mut dy) = if length == 0.0 {
        (1.0, 0.0)
    } else {
        (x / length, y / length)
    };
    let (first, last) = (frame.points[0], frame.points[frame.points.len() - 1]);
    if (last.x - first.x) * dx + (last.y - first.y) * dy < 0.0 {
        dx = -dx;
        dy = -dy;
    }
    let (mut min, mut max) = (f64::INFINITY, f64::NEG_INFINITY);
    for p in &frame.points {
        let distance = (p.x - mean_x) * dx + (p.y - mean_y) * dy;
        min = min.min(distance);
        max = max.max(distance);
    }
    let start = frame.to_world(Point {
        x: mean_x + min * dx,
        y: mean_y + min * dy,
    })?;
    let end = frame.to_world(Point {
        x: mean_x + max * dx,
        y: mean_y + max * dy,
    })?;
    if start == end {
        return Ok(None);
    }
    Ok(Some(measure(points, Line { start, end })?))
}
