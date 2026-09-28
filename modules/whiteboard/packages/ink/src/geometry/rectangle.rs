use super::shared::{measure, normalize};
use crate::validation::finite;
use crate::{Fit, InkError, Point, Rectangle};

fn cross(a: Point, b: Point, c: Point) -> f64 {
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
}

fn hull_half(points: impl Iterator<Item = Point>) -> Vec<Point> {
    let mut result = Vec::new();
    for p in points {
        while result.len() >= 2
            && cross(result[result.len() - 2], result[result.len() - 1], p) <= 0.0
        {
            result.pop();
        }
        result.push(p);
    }
    result.pop();
    result
}

fn convex_hull(points: &[Point]) -> Vec<Point> {
    let mut sorted = points.to_vec();
    sorted.sort_by(|a, b| a.x.total_cmp(&b.x).then(a.y.total_cmp(&b.y)));
    let mut result = hull_half(sorted.iter().copied());
    result.extend(hull_half(sorted.iter().rev().copied()));
    result
}

struct Bounds {
    min_x: f64,
    min_y: f64,
    max_x: f64,
    max_y: f64,
}

impl Bounds {
    fn area(&self) -> f64 {
        (self.max_x - self.min_x) * (self.max_y - self.min_y)
    }
}

fn bounds(points: &[Point], angle: f64) -> Bounds {
    let (s, c) = angle.sin_cos();
    let mut b = Bounds {
        min_x: f64::INFINITY,
        min_y: f64::INFINITY,
        max_x: f64::NEG_INFINITY,
        max_y: f64::NEG_INFINITY,
    };
    for p in points {
        let (x, y) = (p.x * c + p.y * s, -p.x * s + p.y * c);
        b.min_x = b.min_x.min(x);
        b.min_y = b.min_y.min(y);
        b.max_x = b.max_x.max(x);
        b.max_y = b.max_y.max(y);
    }
    b
}

/// 从有界采样的凸包边选择较小面积方向，再用全部原始点计算包围边界与误差。
/// 支持旋转；不足三个非共线点或数值退化时返回 None，不改写原输入。
///
/// # Errors
/// 坐标不是有限值、跨度或计算结果溢出时返回错误。
pub fn fit_rectangle(points: &[Point]) -> Result<Option<Fit<Rectangle>>, InkError> {
    let Some(frame) = normalize(points)? else {
        return Ok(None);
    };
    if frame.samples.len() < 3 {
        return Ok(None);
    }
    let hull = convex_hull(&frame.samples);
    if hull.len() < 3 {
        return Ok(None);
    }
    let (mut best_angle, mut best_area) = (0.0, f64::INFINITY);
    for i in 0..hull.len() {
        let (a, b) = (hull[i], hull[(i + 1) % hull.len()]);
        if a == b {
            continue;
        }
        let angle = (b.y - a.y).atan2(b.x - a.x);
        let area = bounds(&frame.samples, angle).area();
        if area < best_area {
            best_angle = angle;
            best_area = area;
        }
    }
    let b = bounds(&frame.points, best_angle);
    if b.max_x - b.min_x < 1e-12 || b.max_y - b.min_y < 1e-12 {
        return Ok(None);
    }
    let (x, y) = ((b.min_x + b.max_x) / 2.0, (b.min_y + b.max_y) / 2.0);
    let (s, c) = best_angle.sin_cos();
    let (width, height) = (
        (b.max_x - b.min_x) * frame.scale,
        (b.max_y - b.min_y) * frame.scale,
    );
    finite(width, "矩形宽度")?;
    finite(height, "矩形高度")?;
    if width == 0.0 || height == 0.0 {
        return Ok(None);
    }
    let geometry = Rectangle {
        center: frame.to_world(Point {
            x: x * c - y * s,
            y: x * s + y * c,
        })?,
        width,
        height,
        angle: best_angle,
    };
    Ok(Some(measure(points, geometry)?))
}
