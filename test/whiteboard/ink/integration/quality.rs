//! 用已知几何、参考滤波输出和未见未来采样验证质量，不以实现自己的公式作为答案。
#[path = "../support/mod.rs"]
mod support;

use nous_ink::{fit_circle, fit_line, fit_rectangle, OneEuroSmoother, Point, StrokePredictor};
use support::*;

fn noise(state: &mut u64) -> f64 {
    *state = state
        .wrapping_mul(6364136223846793005)
        .wrapping_add(1442695040888963407);
    ((*state >> 11) as f64 / (1_u64 << 53) as f64 * 2.0 - 1.0) * 0.8
}

fn noisy_arc(degrees: f64, seed: u64) -> Vec<Point> {
    let mut state = seed;
    (0..80)
        .map(|i| {
            let angle = (f64::from(i) / 79.0 - 0.5) * degrees.to_radians();
            point(
                80.0 * angle.cos() + noise(&mut state),
                80.0 * angle.sin() + noise(&mut state),
            )
        })
        .collect()
}

fn noisy_rectangle(seed: u64) -> Vec<Point> {
    let mut state = seed;
    let angle: f64 = 0.37;
    (0..160)
        .map(|i| {
            let t = (f64::from(i % 40) + 0.5) / 40.0;
            let (x, y) = match i / 40 {
                0 => (-40.0 + 80.0 * t, -20.0 + noise(&mut state)),
                1 => (40.0 + noise(&mut state), -20.0 + 40.0 * t),
                2 => (40.0 - 80.0 * t, 20.0 + noise(&mut state)),
                _ => (-40.0 + noise(&mut state), 20.0 - 40.0 * t),
            };
            point(
                200.0 + x * angle.cos() - y * angle.sin(),
                100.0 + x * angle.sin() + y * angle.cos(),
            )
        })
        .collect()
}

#[test]
fn smoothing_matches_author_reference_for_irregular_sampling() {
    // 数据由作者当前 C++ 参考实现生成，保留 17 位有效数字。
    // 来源：https://github.com/casiez/OneEuroFilter/blob/main/cpp/OneEuroFilter.cpp
    let inputs = [
        (0.0, 0.0, 0.0),
        (8.0, 1.6, 0.09040690900187377),
        (13.0, 2.3, 0.18698117285553428),
        (24.0, 4.5, 0.695141130731951),
        (40.0, 8.0, 2.2461199601064425),
        (56.0, 9.0, 3.9281568217265495),
        (80.0, 9.2, 5.774158496844686),
        (90.0, 9.2, 6.438139982300994),
    ];
    let mut smoother = OneEuroSmoother::default();
    for (time, value, expected) in inputs {
        near(
            smoother.push(sample(value, 0.0, time)).unwrap().position.x,
            expected,
            1e-12,
        );
    }
}

#[test]
fn line_fitting_is_invariant_to_subdivision_of_the_same_path() {
    let sparse = [point(-30.0, 0.0), point(0.0, 3.0), point(30.0, 0.0)];
    let mut dense: Vec<_> = (0..=80)
        .map(|i| {
            let t = f64::from(i) / 80.0;
            point(-30.0 + 30.0 * t, 3.0 * t)
        })
        .collect();
    dense.push(point(30.0, 0.0));
    let a = fit_line(&sparse).unwrap().unwrap().geometry;
    let b = fit_line(&dense).unwrap().unwrap().geometry;
    near_point(a.start, b.start, 1e-9);
    near_point(a.end, b.end, 1e-9);
}

#[test]
fn short_noisy_arcs_do_not_have_large_systematic_radius_bias() {
    let mut relative_error = 0.0;
    let mut rms = 0.0;
    for seed in 1..=25 {
        let result = fit_circle(&noisy_arc(30.0, seed))
            .unwrap()
            .expect("有曲率的圆弧应能拟合");
        relative_error += (result.geometry.radius - 80.0).abs() / 80.0;
        rms += result.rms_deviation;
    }
    relative_error /= 25.0;
    rms /= 25.0;
    eprintln!("短圆弧：平均半径相对误差={relative_error:.6}，平均几何 RMS={rms:.6}");
    assert!(relative_error < 0.08, "平均半径误差 {relative_error}");
    assert!(rms < 0.47, "平均几何误差 {rms}");
}

#[test]
fn complete_circles_keep_their_accuracy() {
    let mut relative_error = 0.0;
    for seed in 1..=25 {
        let fit = fit_circle(&noisy_arc(360.0, seed)).unwrap().unwrap();
        relative_error += (fit.geometry.radius - 80.0).abs() / 80.0;
    }
    assert!(relative_error / 25.0 < 0.003);
}

#[test]
fn rectangle_fit_does_not_expand_to_enclose_noise_extrema() {
    let mut dimension_error = 0.0;
    let mut rms = 0.0;
    for seed in 1..=25 {
        let result = fit_rectangle(&noisy_rectangle(seed))
            .unwrap()
            .expect("完整矩形应能拟合");
        let g = result.geometry;
        dimension_error += ((g.width.max(g.height) - 80.0).abs() / 80.0
            + (g.width.min(g.height) - 40.0).abs() / 40.0)
            / 2.0;
        rms += result.rms_deviation;
    }
    dimension_error /= 25.0;
    rms /= 25.0;
    eprintln!("噪声矩形：平均尺寸相对误差={dimension_error:.6}，平均几何 RMS={rms:.6}");
    assert!(dimension_error < 0.01, "平均尺寸误差 {dimension_error}");
    assert!(rms < 0.55, "平均几何误差 {rms}");
}

#[test]
fn predictable_acceleration_is_not_reduced_to_average_past_velocity() {
    for interval in [8.0, 16.0] {
        let mut predictor = StrokePredictor::default();
        for i in 0..8 {
            let t = f64::from(i) * interval;
            predictor.push(sample(0.002 * t * t, 0.0, t)).unwrap();
        }
        let time = 7.0 * interval + 16.0;
        let next = predictor
            .predict(time)
            .unwrap()
            .expect("匀加速轨迹具有可预测性");
        near(next.position.x, 0.002 * time * time, 1e-8);
    }
}

#[test]
fn smooth_curved_motion_uses_curvature_without_reading_future_samples() {
    let position = |t: f64| point(100.0 * (0.004 * t).cos(), 100.0 * (0.004 * t).sin());
    let mut predictor = StrokePredictor::default();
    for i in 0..8 {
        let t = f64::from(i) * 8.0;
        let p = position(t);
        predictor.push(sample(p.x, p.y, t)).unwrap();
    }
    let predicted = predictor
        .predict(72.0)
        .unwrap()
        .expect("平滑圆弧应保留有效预测");
    let actual = position(72.0);
    let error = (predicted.position.x - actual.x).hypot(predicted.position.y - actual.y);
    assert!(error < 0.2, "圆弧未来位置误差 {error}");
}

#[test]
fn curved_model_does_not_explain_straight_line_noise_as_acceleration() {
    let (mut squared_error, mut count) = (0.0, 0);
    for seed in 1..=100 {
        let mut state = seed;
        let mut predictor = StrokePredictor::default();
        for i in 0..80 {
            let t = f64::from(i) * 8.0;
            let x = 0.4 * t + noise(&mut state) / 4.0;
            let y = 0.1 * t + noise(&mut state) / 4.0;
            predictor.push(sample(x, y, t)).unwrap();
            if i < 6 {
                continue;
            }
            let p = predictor
                .predict(t + 16.0)
                .unwrap()
                .map_or(point(x, y), |p| p.position);
            squared_error += (p.x - 0.4 * (t + 16.0)).powi(2) + (p.y - 0.1 * (t + 16.0)).powi(2);
            count += 1;
        }
    }
    let rms = (squared_error / f64::from(count)).sqrt();
    eprintln!("带噪匀速：{count} 次预测，位置 RMS={rms:.6}");
    // 同组输入在已提交基线 0756c7d 上为 0.346974；新增曲率能力不能靠放大抖动换取。
    assert!(rms < 0.35, "带噪匀速退化：{rms}");
}
