use super::shared::{measure, normalize};
use crate::validation::finite;
use crate::{Circle, Fit, InkError, Point};

fn solve(mut matrix: [[f64; 4]; 3]) -> Option<[f64; 3]> {
    for column in 0..3 {
        let mut pivot = column;
        for row in column + 1..3 {
            if matrix[row][column].abs() > matrix[pivot][column].abs() {
                pivot = row;
            }
        }
        if matrix[pivot][column].abs() < 1e-12 {
            return None;
        }
        matrix.swap(pivot, column);
        let divisor = matrix[column][column];
        for value in &mut matrix[column][column..] {
            *value /= divisor;
        }
        let pivot_row = matrix[column];
        for (row, values) in matrix.iter_mut().enumerate() {
            if row == column {
                continue;
            }
            let factor = values[column];
            for (value, pivot) in values[column..].iter_mut().zip(&pivot_row[column..]) {
                *value -= factor * pivot;
            }
        }
    }
    Some([matrix[0][3], matrix[1][3], matrix[2][3]])
}

/// 在归一化空间求解圆的代数最小二乘，再检查所有原始点的径向误差。
/// 不判断闭合、不补全圆弧；不足三点、共线或数值退化时返回 None。
///
/// # Errors
/// 坐标不是有限值、跨度或计算结果溢出时返回错误。
pub fn fit_circle(points: &[Point]) -> Result<Option<Fit<Circle>>, InkError> {
    let Some(frame) = normalize(points)? else {
        return Ok(None);
    };
    if frame.samples.len() < 3 {
        return Ok(None);
    }
    let mut matrix = [[0.0; 4]; 3];
    for p in &frame.samples {
        let terms = [p.x, p.y, 1.0];
        let target = -(p.x * p.x + p.y * p.y);
        for (row, values) in matrix.iter_mut().enumerate() {
            for (col, term) in terms.iter().enumerate() {
                values[col] += terms[row] * term;
            }
            values[3] += terms[row] * target;
        }
    }
    let Some(solution) = solve(matrix) else {
        return Ok(None);
    };
    let center = Point {
        x: -solution[0] / 2.0,
        y: -solution[1] / 2.0,
    };
    let radius_squared = center.x * center.x + center.y * center.y - solution[2];
    if radius_squared <= 0.0 {
        return Ok(None);
    }
    let radius = radius_squared.sqrt() * frame.scale;
    finite(radius, "圆半径")?;
    if radius == 0.0 {
        return Ok(None);
    }
    Ok(Some(measure(
        points,
        Circle {
            center: frame.to_world(center)?,
            radius,
        },
    )?))
}
