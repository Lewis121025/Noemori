//! 笔迹测试的数值断言与确定性输入。
#![allow(dead_code)]

use nous_ink::{Point, StrokeSample};

/// 构造不含压感的真实采样，避免各测试重复样本装配。
pub fn sample(x: f64, y: f64, time_ms: f64) -> StrokeSample {
    StrokeSample {
        position: point(x, y),
        time_ms,
        pressure: None,
    }
}

/// 构造坐标值，合法性由内核入口验证。
pub fn point(x: f64, y: f64) -> Point {
    Point { x, y }
}

/// 按绝对误差断言；非有限结果不能被 NaN 比较掩盖。
pub fn near(actual: f64, expected: f64, tolerance: f64) {
    assert!(
        actual.is_finite() && (actual - expected).abs() <= tolerance,
        "实际 {actual}，期望 {expected}，容差 {tolerance}"
    );
}

/// 比较二维点。
pub fn near_point(actual: Point, expected: Point, tolerance: f64) {
    near(actual.x, expected.x, tolerance);
    near(actual.y, expected.y, tolerance);
}

/// 生成首尾重合的圆形笔迹。
pub fn circle(radius: f64, count: usize) -> Vec<Point> {
    (0..=count)
        .map(|i| {
            let a = i as f64 / count as f64 * std::f64::consts::TAU;
            point(100.0 + a.cos() * radius, -50.0 + a.sin() * radius)
        })
        .collect()
}

/// 生成具有旋转角的矩形边界笔迹。
pub fn rectangle(angle: f64) -> Vec<Point> {
    let corners = [
        point(-40.0, -20.0),
        point(40.0, -20.0),
        point(40.0, 20.0),
        point(-40.0, 20.0),
    ];
    (0..=80)
        .map(|i| {
            let side = (i / 20).min(3);
            let a = corners[side];
            let b = corners[(side + 1) % 4];
            let t = (i - side * 20) as f64 / 20.0;
            let x = a.x + (b.x - a.x) * t;
            let y = a.y + (b.y - a.y) * t;
            point(
                200.0 + x * angle.cos() - y * angle.sin(),
                100.0 + x * angle.sin() + y * angle.cos(),
            )
        })
        .collect()
}
