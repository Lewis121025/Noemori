use super::shared::{measure, normalize, weighted_points, WeightedPoint};
use crate::validation::finite;
use crate::{Fit, InkError, Point, Rectangle};
use levenberg_marquardt::{LeastSquaresProblem, LevenbergMarquardt};
use nalgebra::{storage::Owned, DVector, Dyn, OMatrix, Vector5, U1, U5};

// 私有数学实现的测试仍集中在仓库根部，不为测试扩大公开 API。
#[cfg(test)]
#[path = "../../../../../../test/whiteboard/ink/unit/rectangle_derivatives.rs"]
mod derivative_tests;

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
    sorted.dedup();
    let mut hull = hull_half(sorted.iter().copied());
    hull.extend(hull_half(sorted.iter().rev().copied()));
    hull
}

fn enclosing_rectangle(points: &[Point], angle: f64) -> Rectangle {
    let (s, c) = angle.sin_cos();
    let (mut min_x, mut min_y) = (f64::INFINITY, f64::INFINITY);
    let (mut max_x, mut max_y) = (f64::NEG_INFINITY, f64::NEG_INFINITY);
    for p in points {
        let (x, y) = (p.x * c + p.y * s, -p.x * s + p.y * c);
        min_x = min_x.min(x);
        max_x = max_x.max(x);
        min_y = min_y.min(y);
        max_y = max_y.max(y);
    }
    let (x, y) = ((min_x + max_x) / 2.0, (min_y + max_y) / 2.0);
    Rectangle {
        center: Point {
            x: x * c - y * s,
            y: x * s + y * c,
        },
        width: max_x - min_x,
        height: max_y - min_y,
        angle,
    }
}

fn initial_rectangle(points: &[Point]) -> Option<Rectangle> {
    let hull = convex_hull(points);
    if hull.len() < 3 {
        return None;
    }
    let mut best: Option<Rectangle> = None;
    // 初值只评估有限个凸包方向，避免圆形等密集凸包触发平方复杂度；
    // 每个方向的边界和后续非线性拟合都使用完整数据。
    for i in (0..hull.len()).step_by(hull.len().div_ceil(64)) {
        let a = hull[i];
        let b = hull[(i + 1) % hull.len()];
        let candidate = enclosing_rectangle(&hull, (b.y - a.y).atan2(b.x - a.x));
        if best.is_none_or(|r| candidate.width * candidate.height < r.width * r.height) {
            best = Some(candidate);
        }
    }
    best.filter(|r| r.width > 1e-12 && r.height > 1e-12)
}

/// 矩形的中心、对数半尺寸与旋转角；边界残差同时约束内部和外部观测。
struct RectangleProblem<'a> {
    parameters: Vector5<f64>,
    samples: &'a [WeightedPoint],
}

impl RectangleProblem<'_> {
    fn geometry(&self) -> Option<Rectangle> {
        let width = 2.0 * self.parameters[2].exp();
        let height = 2.0 * self.parameters[3].exp();
        if !self.parameters.iter().all(|v| v.is_finite())
            || !width.is_finite()
            || !height.is_finite()
            || width == 0.0
            || height == 0.0
        {
            return None;
        }
        Some(Rectangle {
            center: Point {
                x: self.parameters[0],
                y: self.parameters[1],
            },
            width,
            height,
            angle: self.parameters[4],
        })
    }
}

/// 矩形的有符号边界距离和解析梯度；内点也保留残差，因此不会把包围所有点当作完成拟合。
fn boundary_distance(p: Point, geometry: Rectangle) -> (f64, [f64; 5]) {
    let (s, c) = geometry.angle.sin_cos();
    let (dx, dy) = (p.x - geometry.center.x, p.y - geometry.center.y);
    let (u, v) = (dx * c + dy * s, -dx * s + dy * c);
    let (hw, hh) = (geometry.width / 2.0, geometry.height / 2.0);
    let (qx, qy) = (u.abs() - hw, v.abs() - hh);
    let (distance, du, dv, dw, dh) = if qx > 0.0 && qy > 0.0 {
        let distance = qx.hypot(qy);
        (
            distance,
            qx / distance * u.signum(),
            qy / distance * v.signum(),
            -qx / distance,
            -qy / distance,
        )
    } else if qx >= qy {
        (qx, u.signum(), 0.0, -1.0, 0.0)
    } else {
        (qy, 0.0, v.signum(), 0.0, -1.0)
    };
    (
        distance,
        [
            -du * c + dv * s,
            -du * s - dv * c,
            dw * hw,
            dh * hh,
            du * v - dv * u,
        ],
    )
}

impl LeastSquaresProblem<f64, Dyn, U5> for RectangleProblem<'_> {
    type ParameterStorage = Owned<f64, U5, U1>;
    type ResidualStorage = Owned<f64, Dyn, U1>;
    type JacobianStorage = Owned<f64, Dyn, U5>;

    fn set_params(&mut self, parameters: &Vector5<f64>) {
        self.parameters = *parameters;
    }
    fn params(&self) -> Vector5<f64> {
        self.parameters
    }

    fn residuals(&self) -> Option<DVector<f64>> {
        let geometry = self.geometry()?;
        Some(DVector::from_iterator(
            self.samples.len(),
            self.samples
                .iter()
                .map(|p| boundary_distance(p.position, geometry).0 * p.root_weight),
        ))
    }

    fn jacobian(&self) -> Option<OMatrix<f64, Dyn, U5>> {
        let geometry = self.geometry()?;
        let mut jacobian = OMatrix::<f64, Dyn, U5>::zeros(self.samples.len());
        for (row, p) in self.samples.iter().enumerate() {
            let (_, gradient) = boundary_distance(p.position, geometry);
            for column in 0..5 {
                jacobian[(row, column)] = gradient[column] * p.root_weight;
            }
        }
        Some(jacobian)
    }
}

/// 以包围矩形为初值，最小化原始采样到矩形边界的加权几何距离。
/// 支持旋转且不要求结果包住噪声；数据不足、退化或未收敛时返回 None。
///
/// # Errors
/// 坐标不是有限值、跨度或最终几何溢出时返回错误；输入保持不变。
pub fn fit_rectangle(points: &[Point]) -> Result<Option<Fit<Rectangle>>, InkError> {
    let Some(frame) = normalize(points)? else {
        return Ok(None);
    };
    let Some(initial) = initial_rectangle(&frame.points) else {
        return Ok(None);
    };
    let samples = weighted_points(&frame.points);
    let parameters = Vector5::new(
        initial.center.x,
        initial.center.y,
        (initial.width / 2.0).ln(),
        (initial.height / 2.0).ln(),
        initial.angle,
    );
    let problem = RectangleProblem {
        parameters,
        samples: &samples,
    };
    let (result, report) = LevenbergMarquardt::new()
        .with_patience(80)
        .minimize(problem);
    if !report.termination.was_successful() {
        return Ok(None);
    }
    let Some(local) = result.geometry() else {
        return Ok(None);
    };
    let width = local.width * frame.scale;
    let height = local.height * frame.scale;
    finite(width, "矩形宽度")?;
    finite(height, "矩形高度")?;
    if width == 0.0 || height == 0.0 {
        return Ok(None);
    }
    let geometry = Rectangle {
        center: frame.to_world(local.center)?,
        width,
        height,
        angle: local.angle,
    };
    Ok(Some(measure(points, geometry)?))
}
