use crate::validation::{checked_point, finite, point};
use crate::{Circle, Fit, Geometry, InkError, Line, Point, Rectangle};

/// 在局部单位坐标中求解，再回到原坐标，避免大数平方项相消。
pub(super) struct NormalizedStroke {
    origin: Point,
    pub scale: f64,
    pub points: Vec<Point>,
}

impl NormalizedStroke {
    /// 恢复输入坐标；数值溢出返回错误，不能产出非有限几何。
    pub(super) fn to_world(&self, p: Point) -> Result<Point, InkError> {
        checked_point(
            self.origin.x + p.x * self.scale,
            self.origin.y + p.y * self.scale,
        )
    }
}

/// 原始位置及其邻接弧长的平方根权重，供加权最小二乘直接乘到残差和雅可比上。
pub(super) struct WeightedPoint {
    pub position: Point,
    pub root_weight: f64,
}

/// 只在原始位置上积分；不插值制造圆弧弦内点，也不因固定点数阈值丢弃几何信息。
pub(super) fn weighted_points(input: &[Point]) -> Vec<WeightedPoint> {
    let mut points = input.to_vec();
    points.dedup();
    let mut weights = vec![0.0; points.len()];
    let mut total = 0.0;
    for (i, segment) in points.windows(2).enumerate() {
        let length = (segment[1].x - segment[0].x).hypot(segment[1].y - segment[0].y);
        weights[i] += length / 2.0;
        weights[i + 1] += length / 2.0;
        total += length;
    }
    points
        .into_iter()
        .zip(weights)
        .map(|(position, weight)| WeightedPoint {
            position,
            root_weight: (weight / total).sqrt(),
        })
        .collect()
}

pub(super) fn normalize(points: &[Point]) -> Result<Option<NormalizedStroke>, InkError> {
    let (mut min_x, mut min_y) = (f64::INFINITY, f64::INFINITY);
    let (mut max_x, mut max_y) = (f64::NEG_INFINITY, f64::NEG_INFINITY);
    for p in points {
        point(*p)?;
        min_x = min_x.min(p.x);
        min_y = min_y.min(p.y);
        max_x = max_x.max(p.x);
        max_y = max_y.max(p.y);
    }
    if points.len() < 2 {
        return Ok(None);
    }
    let scale = (max_x - min_x).max(max_y - min_y);
    finite(scale, "笔迹跨度")?;
    if scale == 0.0 {
        return Ok(None);
    }
    let origin = checked_point(min_x + (max_x - min_x) / 2.0, min_y + (max_y - min_y) / 2.0)?;
    let normalized: Vec<_> = points
        .iter()
        .map(|p| Point {
            x: (p.x - origin.x) / scale,
            y: (p.y - origin.y) / scale,
        })
        .collect();
    Ok(Some(NormalizedStroke {
        origin,
        scale,
        points: normalized,
    }))
}

pub(crate) trait Project {
    fn project(&self, point: Point) -> Result<Point, InkError>;
}

impl Project for Line {
    fn project(&self, p: Point) -> Result<Point, InkError> {
        let (dx, dy) = (self.end.x - self.start.x, self.end.y - self.start.y);
        let length = dx.hypot(dy);
        let (x, y) = (dx / length, dy / length);
        let distance = ((p.x - self.start.x) * x + (p.y - self.start.y) * y).clamp(0.0, length);
        checked_point(self.start.x + distance * x, self.start.y + distance * y)
    }
}

impl Project for Circle {
    fn project(&self, p: Point) -> Result<Point, InkError> {
        let (dx, dy) = (p.x - self.center.x, p.y - self.center.y);
        let length = dx.hypot(dy);
        let (x, y) = if length == 0.0 {
            (1.0, 0.0)
        } else {
            (dx / length, dy / length)
        };
        checked_point(
            self.center.x + x * self.radius,
            self.center.y + y * self.radius,
        )
    }
}

impl Project for Rectangle {
    fn project(&self, p: Point) -> Result<Point, InkError> {
        let (s, c) = self.angle.sin_cos();
        let (dx, dy) = (p.x - self.center.x, p.y - self.center.y);
        let (px, py) = (dx * c + dy * s, -dx * s + dy * c);
        let (hw, hh) = (self.width / 2.0, self.height / 2.0);
        let (mut x, mut y) = (px.clamp(-hw, hw), py.clamp(-hh, hh));
        if px.abs() <= hw && py.abs() <= hh {
            if hw - px.abs() <= hh - py.abs() {
                x = if px < 0.0 { -hw } else { hw };
            } else {
                y = if py < 0.0 { -hh } else { hh };
            }
        }
        checked_point(self.center.x + x * c - y * s, self.center.y + x * s + y * c)
    }
}

impl Project for Geometry {
    fn project(&self, point: Point) -> Result<Point, InkError> {
        match self {
            Self::Line(g) => g.project(point),
            Self::Circle(g) => g.project(point),
            Self::Rectangle(g) => g.project(point),
        }
    }
}

pub(super) fn measure<G: Project>(points: &[Point], geometry: G) -> Result<Fit<G>, InkError> {
    let (mut maximum, mut squares) = (0.0, 0.0);
    for p in points {
        let projected = geometry.project(*p)?;
        let distance = (p.x - projected.x).hypot(p.y - projected.y);
        finite(distance, "拟合偏差")?;
        // 缩放平方和避免大距离直接平方后溢出，最大偏差检查始终覆盖所有原始点。
        if distance > maximum {
            squares = 1.0 + squares * (maximum / distance).powi(2);
            maximum = distance;
        } else if maximum > 0.0 {
            squares += (distance / maximum).powi(2);
        }
    }
    let rms_deviation = if maximum == 0.0 {
        0.0
    } else {
        maximum * (squares / points.len() as f64).sqrt()
    };
    Ok(Fit {
        geometry,
        rms_deviation,
        max_deviation: maximum,
    })
}
