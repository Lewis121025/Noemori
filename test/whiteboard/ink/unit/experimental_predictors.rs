//! 候选模型先验证数学状态和查询契约，再参与数据集评分。
use super::*;

fn sample(x: f64, y: f64, time_ms: f64) -> StrokeSample {
    StrokeSample {
        position: Point { x, y },
        time_ms,
        pressure: None,
    }
}

#[test]
fn android_core_matches_independent_numpy_direct_covariance_reference() {
    // 固定上游 F/Q/R，用 NumPy 的 P-KHP 公式生成；被测实现使用数值更稳定的 Joseph 形式。
    let inputs = [
        (0.0, 0.0),
        (1.0, 0.5),
        (2.2, 1.1),
        (3.4, 1.7),
        (4.5, 2.1),
        (5.7, 2.2),
        (6.8, 2.0),
        (7.6, 1.6),
        (8.2, 1.0),
        (8.6, 0.3),
    ];
    let expected = [
        [8.523078187668943, 0.15472460818887046],
        [0.02253997037843397, -1.1721547116288062],
        [-0.45507899884978714, -0.39912709800944446],
        [-0.08343036077656285, -0.041588153621413264],
    ];
    let mut filter = AndroidCore::default();
    for (i, (x, y)) in inputs.into_iter().enumerate() {
        filter.push(sample(x, y, i as f64 * 8.0)).unwrap();
    }
    for (row, values) in expected.iter().enumerate() {
        for (column, value) in values.iter().enumerate() {
            assert!((filter.state[(row, column)] - value).abs() < 1e-10);
        }
    }
}

#[test]
fn experimental_budget_preserves_valid_predictions_near_world_origin() {
    for x in 1..20 {
        for y in 1..20 {
            let (x, y) = (f64::from(x), f64::from(y));
            let norm = x.hypot(y);
            let input = sample(-24.0 * x / norm, -24.0 * y / norm, 8.0);
            let result = bounded(
                input,
                32.0,
                Point {
                    x: 100.0 * x / norm,
                    y: 100.0 * y / norm,
                },
            )
            .unwrap()
            .unwrap();
            assert!(
                (result.position.x - input.position.x).hypot(result.position.y - input.position.y)
                    <= 24.0
            );
            assert!(result.position.x.hypot(result.position.y) < 1e-10);
        }
    }
}

#[test]
fn time_window_increases_evidence_only_when_reporting_rate_increases() {
    for (dt, expected) in [(2.0, 25), (16.0, 6)] {
        let mut p = TimeWindow::new(48.0, 6);
        for i in 0..100 {
            let t = f64::from(i) * dt;
            p.push(sample(t, 0.0, t)).unwrap();
        }
        assert_eq!(p.samples.len(), expected);
    }
}

#[test]
fn continuous_kalman_preserves_velocity_with_irregular_sample_times() {
    let mut p = ContinuousKalman::<3>::new(32.0);
    for t in [0.0, 2.0, 9.0, 14.0, 31.0, 42.0, 46.0, 61.0] {
        p.push(sample(100.0 + 0.4 * t, 200.0 - 0.2 * t, t)).unwrap();
    }
    let p = p.predict(77.0).unwrap().unwrap().position;
    assert!((p.x - 130.8).abs() < 1e-10);
    assert!((p.y - 184.6).abs() < 1e-10);
}

#[test]
fn joseph_covariance_remains_symmetric_and_positive() {
    let mut p = ContinuousKalman::<3>::new(16.0);
    let mut t = 0.0;
    for i in 0..200 {
        t += [2.0, 8.0, 3.0, 17.0][i % 4];
        p.push(sample(
            t * 0.4 + (i as f64).sin(),
            (t * 0.01).sin() * 20.0,
            t,
        ))
        .unwrap();
        assert!((p.covariance - p.covariance.transpose()).norm() < 1e-10);
        assert!(p.covariance.symmetric_eigen().eigenvalues.min() >= -1e-12);
    }
}

#[test]
fn continuous_jerk_noise_matches_independent_gauss_quadrature() {
    // 四点 Gauss–Legendre 对六次多项式精确积分，独立核对连续过程噪声积分。
    let filter = ContinuousKalman::<4>::new(32.0);
    let dt: f64 = 17.0;
    let nodes = [
        (-0.8611363115940526, 0.3478548451374538),
        (-0.3399810435848563, 0.6521451548625461),
        (0.3399810435848563, 0.6521451548625461),
        (0.8611363115940526, 0.3478548451374538),
    ];
    let mut expected = Matrix4::zeros();
    for (node, weight) in nodes {
        let t = (node + 1.0) * dt / 2.0;
        let g = Vector4::new(t * t * t / 6.0, t * t / 2.0, t, 1.0);
        expected += g * g.transpose() * (weight * dt / 2.0 * 252.0 / 32.0_f64.powi(7));
    }
    assert!((filter.process_noise(dt) - expected).norm() / expected.norm() < 1e-13);
}

#[test]
fn generalizing_dimension_preserves_original_acceleration_process_noise() {
    let filter = ContinuousKalman::<3>::new(32.0);
    for dt in [2.0_f64, 8.0, 16.7] {
        let expected = nalgebra::Matrix3::new(
            dt.powi(5) / 20.0,
            dt.powi(4) / 8.0,
            dt.powi(3) / 6.0,
            dt.powi(4) / 8.0,
            dt.powi(3) / 3.0,
            dt * dt / 2.0,
            dt.powi(3) / 6.0,
            dt * dt / 2.0,
            dt,
        ) * (20.0 / 32.0_f64.powi(5));
        assert!((filter.process_noise(dt) - expected).norm() / expected.norm() < 1e-14);
    }
}

#[test]
fn every_candidate_keeps_queries_pure_bounded_and_invalid_input_atomic() {
    for name in [
        "baseline",
        "count12",
        "time32",
        "time48",
        "time64",
        "time48_strict",
        "kalman16",
        "kalman32",
        "kalman32_noise",
        "kalman32_adaptive",
        "kalman64",
        "androidx_core",
        "kalman16_guarded",
        "kalman32_guarded",
        "kalman64_guarded",
        "androidx_core_guarded",
        "time32_strict",
        "time64_strict",
        "jerk16",
        "jerk32",
        "jerk64",
    ] {
        let mut p = create(name);
        for i in 0..20 {
            let t = f64::from(i) * 2.0;
            p.push(sample(t, t * 0.2, t)).unwrap();
        }
        let before = p.predict(54.0).unwrap();
        p.predict(62.0).unwrap();
        p.predict(42.0).unwrap();
        assert_eq!(p.predict(54.0).unwrap(), before, "{name}");
        assert!(p.push(sample(0.0, 0.0, 38.0)).is_err());
        assert_eq!(p.predict(54.0).unwrap(), before, "{name}");
        assert_eq!(p.predict(63.0).unwrap(), None);
        if let Some(point) = p.predict(62.0).unwrap() {
            assert!((point.position.x - 38.0).hypot(point.position.y - 7.6) <= 24.0);
        }
        p.push(sample(500.0, 200.0, 500.0)).unwrap();
        assert_eq!(p.predict(508.0).unwrap(), None, "{name}");
    }
}

#[test]
fn noise_estimate_rejects_quadratic_motion_and_preserves_scale() {
    let mut clean = MeasurementNoise::default();
    let mut noisy = MeasurementNoise::default();
    let mut scaled = MeasurementNoise::default();
    let mut t = 0.0;
    let (mut r, mut s) = (0.0, 0.0);
    for i in 0..40 {
        t += [2.0, 3.0, 8.0, 4.0][i % 4];
        let x = 0.001 * t * t + 0.4 * t;
        let y = -0.002 * t * t + 0.2 * t;
        let c = clean.observe(sample(x, y, t));
        if i >= 8 {
            assert!(c < 1e-15, "二次轨迹不应被解释成测量噪声：{c}");
        }
        let nx = x + 0.2 * (i as f64 * 1.7).sin();
        let ny = y + 0.2 * (i as f64 * 2.3).cos();
        r = noisy.observe(sample(nx, ny, t));
        s = scaled.observe(sample(3.0 * nx + 100.0, 3.0 * ny - 100.0, t));
    }
    assert!(r > 0.0);
    assert!((s / r - 9.0).abs() < 1e-8);
}

#[test]
fn adaptive_covariance_stays_finite_through_rest_motion_and_noise_changes() {
    let mut filter = ContinuousKalman::<3>::adaptive(true);
    for i in 0..240 {
        let t = f64::from(i) * 2.0;
        let moving = if i < 80 { 0.0 } else { 0.6 * (t - 160.0) };
        let jitter = if (120..180).contains(&i) {
            0.5 * (f64::from(i) * 1.7).sin()
        } else {
            0.0
        };
        filter
            .push(sample(moving + jitter, 0.2 * jitter, t))
            .unwrap();
        assert!(filter
            .state
            .iter()
            .chain(filter.covariance.iter())
            .all(|v| v.is_finite()));
        assert!((filter.covariance - filter.covariance.transpose()).norm() < 1e-9);
        assert!(filter.covariance.symmetric_eigen().eigenvalues.min() >= -1e-10);
        filter.predict(t + 16.0).unwrap();
    }
}
