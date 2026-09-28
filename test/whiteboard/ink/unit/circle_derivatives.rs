//! 通过有限差分独立核对圆的解析雅可比，防止优化器“收敛”掩盖导数符号或参数化错误。
use super::{CircleProblem, LeastSquaresProblem, Point, Vector3, WeightedPoint};

#[test]
fn circle_jacobian_matches_finite_differences() {
    let samples = [
        WeightedPoint {
            position: Point { x: -0.4, y: 0.2 },
            root_weight: 0.3,
        },
        WeightedPoint {
            position: Point { x: 0.3, y: -0.2 },
            root_weight: 0.6,
        },
        WeightedPoint {
            position: Point { x: 0.4, y: 0.4 },
            root_weight: 0.7,
        },
    ];
    let parameters = Vector3::new(0.05, -0.03, 0.4_f64.ln());
    let mut problem = CircleProblem {
        parameters,
        samples: &samples,
    };
    let jacobian = problem.jacobian().unwrap();
    let step = 1e-6;
    for column in 0..3 {
        let mut plus = parameters;
        plus[column] += step;
        problem.set_params(&plus);
        let upper = problem.residuals().unwrap();
        let mut minus = parameters;
        minus[column] -= step;
        problem.set_params(&minus);
        let lower = problem.residuals().unwrap();
        for row in 0..samples.len() {
            let numerical = (upper[row] - lower[row]) / (2.0 * step);
            assert!(
                (numerical - jacobian[(row, column)]).abs() < 1e-8,
                "圆雅可比：行 {row}，列 {column}，数值 {numerical}，解析 {}",
                jacobian[(row, column)]
            );
        }
    }
}
