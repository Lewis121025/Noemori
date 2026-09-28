use super::shared::{measure, normalize};
use crate::{Fit, InkError, Line, Point};

/// 以折线弧长为测度求正交最小二乘线段；同一路径的线性细分不改变拟合结果。
/// 返回几何及全部采样的误差；位置不足或数值退化时返回 None，不修改输入。
///
/// # Errors
/// 坐标不是有限值、跨度或计算结果溢出时返回错误。
pub fn fit_line(points: &[Point]) -> Result<Option<Fit<Line>>, InkError> {
    let Some(frame) = normalize(points)? else {
        return Ok(None);
    };
    let mut total = 0.0;
    let (mut mean_x, mut mean_y) = (0.0, 0.0);
    for segment in frame.points.windows(2) {
        let (a, b) = (segment[0], segment[1]);
        let length = (b.x - a.x).hypot(b.y - a.y);
        total += length;
        mean_x += length * (a.x + b.x) / 2.0;
        mean_y += length * (a.y + b.y) / 2.0;
    }
    mean_x /= total;
    mean_y /= total;
    let (mut xx, mut xy, mut yy) = (0.0, 0.0, 0.0);
    // 对每条线段解析积分二阶矩，避免顶点数量或局部采样速度充当统计权重。
    for segment in frame.points.windows(2) {
        let (a, b) = (segment[0], segment[1]);
        let length = (b.x - a.x).hypot(b.y - a.y) / total;
        let (ax, ay, bx, by) = (a.x - mean_x, a.y - mean_y, b.x - mean_x, b.y - mean_y);
        xx += length * (ax * ax + ax * bx + bx * bx) / 3.0;
        yy += length * (ay * ay + ay * by + by * by) / 3.0;
        xy += length * (2.0 * ax * ay + ax * by + bx * ay + 2.0 * bx * by) / 6.0;
    }
    // 直接求主特征向量，保留精确轴线；选择相加的一侧避免相近数相减。
    let half_difference = (xx - yy) / 2.0;
    let radius = half_difference.hypot(xy);
    let (x, y) = if half_difference >= 0.0 {
        (radius + half_difference, xy)
    } else {
        (xy, radius - half_difference)
    };
    let length = x.hypot(y);
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
