//! 检查矩形内部、外侧及外角的解析导数，避免旋转与对数尺寸参数使用错误。
use super::{LeastSquaresProblem, Point, RectangleProblem, Vector5, WeightedPoint};

#[test]
fn rectangle_jacobian_matches_finite_differences_away_from_cusps() {
    let samples = [
        WeightedPoint {
            position: Point { x: 0.11, y: -0.07 },
            root_weight: 0.3,
        },
        WeightedPoint {
            position: Point { x: 0.9, y: 0.8 },
            root_weight: 0.4,
        },
        WeightedPoint {
            position: Point { x: 0.6, y: 0.0 },
            root_weight: 0.5,
        },
        WeightedPoint {
            position: Point { x: -0.9, y: -0.1 },
            root_weight: 0.6,
        },
        WeightedPoint {
            position: Point { x: 0.1, y: -0.8 },
            root_weight: 0.7,
        },
    ];
    let parameters = Vector5::new(0.05, -0.03, 0.4_f64.ln(), 0.2_f64.ln(), 0.37);
    let mut problem = RectangleProblem {
        parameters,
        samples: &samples,
    };
    let jacobian = problem.jacobian().unwrap();
    let step = 1e-6;
    for column in 0..5 {
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
                "矩形雅可比：行 {row}，列 {column}，数值 {numerical}，解析 {}",
                jacobian[(row, column)]
            );
        }
    }
}
