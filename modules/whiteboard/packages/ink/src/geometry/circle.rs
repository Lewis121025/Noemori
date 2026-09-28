use super::shared::{measure, normalize, weighted_points, WeightedPoint};
use crate::numerical::{least_squares, sensitivity};
use crate::validation::finite;
use crate::{Circle, CircleAnalysis, CircleSensitivity, Fit, InkError, Point};
use levenberg_marquardt::{LeastSquaresProblem, LevenbergMarquardt};
use nalgebra::{storage::Owned, DMatrix, DVector, Dyn, OMatrix, Vector3, U1, U3};

// 私有数学实现的测试仍集中在仓库根部，不为测试扩大公开 API。
#[cfg(test)]
#[path = "../../../../../../test/whiteboard/ink/unit/circle_derivatives.rs"]
mod derivative_tests;

/// 在归一化坐标中优化圆心与对数半径，避免迭代穿过无效的负半径。
struct CircleProblem<'a> {
    parameters: Vector3<f64>,
    samples: &'a [WeightedPoint],
}

impl LeastSquaresProblem<f64, Dyn, U3> for CircleProblem<'_> {
    type ParameterStorage = Owned<f64, U3, U1>;
    type ResidualStorage = Owned<f64, Dyn, U1>;
    type JacobianStorage = Owned<f64, Dyn, U3>;

    fn set_params(&mut self, parameters: &Vector3<f64>) {
        self.parameters = *parameters;
    }
    fn params(&self) -> Vector3<f64> {
        self.parameters
    }

    fn residuals(&self) -> Option<DVector<f64>> {
        let radius = self.parameters.z.exp();
        if !radius.is_finite() || radius == 0.0 || !self.parameters.iter().all(|v| v.is_finite()) {
            return None;
        }
        Some(DVector::from_iterator(
            self.samples.len(),
            self.samples.iter().map(|p| {
                let distance =
                    (p.position.x - self.parameters.x).hypot(p.position.y - self.parameters.y);
                (distance - radius) * p.root_weight
            }),
        ))
    }

    fn jacobian(&self) -> Option<OMatrix<f64, Dyn, U3>> {
        let radius = self.parameters.z.exp();
        if !radius.is_finite() || radius == 0.0 || !self.parameters.iter().all(|v| v.is_finite()) {
            return None;
        }
        let mut matrix = OMatrix::<f64, Dyn, U3>::zeros(self.samples.len());
        for (row, p) in self.samples.iter().enumerate() {
            let x = self.parameters.x - p.position.x;
            let y = self.parameters.y - p.position.y;
            let distance = x.hypot(y);
            // 圆心与观测重合时取位置的零子梯度，半径残差仍参与优化。
            if distance > 0.0 {
                matrix[(row, 0)] = x / distance * p.root_weight;
                matrix[(row, 1)] = y / distance * p.root_weight;
            }
            matrix[(row, 2)] = -radius * p.root_weight;
        }
        Some(matrix)
    }
}

fn initial_circle(samples: &[WeightedPoint]) -> Result<Option<Vector3<f64>>, InkError> {
    let design = DMatrix::from_fn(samples.len(), 3, |row, column| {
        let p = &samples[row];
        p.root_weight
            * match column {
                0 => p.position.x,
                1 => p.position.y,
                _ => 1.0,
            }
    });
    let observations = DMatrix::from_fn(samples.len(), 1, |row, _| {
        let p = &samples[row];
        -(p.position.x * p.position.x + p.position.y * p.position.y) * p.root_weight
    });
    let Some(solution) = least_squares(design, &observations)? else {
        return Ok(None);
    };
    let (x, y) = (-solution[(0, 0)] / 2.0, -solution[(1, 0)] / 2.0);
    let squared_radius = x * x + y * y - solution[(2, 0)];
    if squared_radius <= 0.0 {
        return Ok(None);
    }
    Ok(Some(Vector3::new(x, y, squared_radius.sqrt().ln())))
}

/// 拟合与诊断共用同一次几何求解；普通拟合调用不额外计算诊断用 SVD。
struct CircleSolution {
    fit: Fit<Circle>,
    parameters: Vector3<f64>,
    samples: Vec<WeightedPoint>,
}

/// 最小化原始点到圆的加权几何距离；SVD 只提供初值，半径以对数参数保证为正。
/// 权重来自邻接弧长，不补全圆弧；数据不足、共线、数值退化或迭代未收敛返回 None。
///
/// # Errors
/// 坐标非法、数值分解失败或最终几何溢出时返回错误，不改变输入。
pub fn fit_circle(points: &[Point]) -> Result<Option<Fit<Circle>>, InkError> {
    Ok(solve_circle(points)?.map(|solution| solution.fit))
}

/// 返回与 fit_circle 相同的候选，并分析圆心/半径的局部可辨识性。
/// 使用径向几何残差和弧长权重，不假设权重是噪声方差，也不将条件数解释为置信概率。
/// 数据不足、共线或拟合未收敛返回 None；诊断无法确定时仍保留候选，sensitivity 为 None。
///
/// # Errors
/// 坐标非法、数值分解失败或计算溢出时返回错误，不修改输入。
pub fn analyze_circle(points: &[Point]) -> Result<Option<CircleAnalysis>, InkError> {
    let Some(solution) = solve_circle(points)? else {
        return Ok(None);
    };
    Ok(Some(CircleAnalysis {
        fit: solution.fit,
        sensitivity: circle_sensitivity(&solution)?,
    }))
}

fn circle_sensitivity(solution: &CircleSolution) -> Result<Option<CircleSensitivity>, InkError> {
    let radius = solution.parameters.z.exp();
    let mut jacobian = DMatrix::zeros(solution.samples.len(), 3);
    let mut residual_norm: f64 = 0.0;
    for (row, p) in solution.samples.iter().enumerate() {
        let x = solution.parameters.x - p.position.x;
        let y = solution.parameters.y - p.position.y;
        let distance = x.hypot(y);
        if distance == 0.0 {
            return Ok(None);
        }
        // 参数均以长度度量；对真实半径求导，而非优化器的对数半径，避免单位选择扭曲条件数。
        jacobian[(row, 0)] = x / distance * p.root_weight;
        jacobian[(row, 1)] = y / distance * p.root_weight;
        jacobian[(row, 2)] = -p.root_weight;
        residual_norm = residual_norm.hypot((distance - radius) * p.root_weight);
    }
    let Some((condition_number, parameter_amplification)) = sensitivity(jacobian)? else {
        return Ok(None);
    };
    let relative_residual_sensitivity = residual_norm / radius * parameter_amplification;
    finite(relative_residual_sensitivity, "圆参数残差敏感度")?;
    Ok(Some(CircleSensitivity {
        condition_number,
        parameter_amplification,
        relative_residual_sensitivity,
    }))
}

fn solve_circle(points: &[Point]) -> Result<Option<CircleSolution>, InkError> {
    let Some(frame) = normalize(points)? else {
        return Ok(None);
    };
    let samples = weighted_points(&frame.points);
    if samples.len() < 3 {
        return Ok(None);
    }
    let Some(parameters) = initial_circle(&samples)? else {
        return Ok(None);
    };
    let problem = CircleProblem {
        parameters,
        samples: &samples,
    };
    let (result, report) = LevenbergMarquardt::new()
        .with_patience(80)
        .minimize(problem);
    if !report.termination.was_successful() {
        return Ok(None);
    }
    let radius = result.parameters.z.exp() * frame.scale;
    finite(radius, "圆半径")?;
    if radius == 0.0 {
        return Ok(None);
    }
    let geometry = Circle {
        center: frame.to_world(Point {
            x: result.parameters.x,
            y: result.parameters.y,
        })?,
        radius,
    };
    Ok(Some(CircleSolution {
        fit: measure(points, geometry)?,
        parameters: result.parameters,
        samples,
    }))
}
