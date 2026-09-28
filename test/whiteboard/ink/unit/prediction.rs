//! 短时预测的有效期、方向与状态隔离契约。
#[path = "../support/mod.rs"]
mod support;
use nous_ink::{PredictionOptions, StrokePredictor};
use support::*;

#[test]
fn insufficient_history_and_zero_horizon_produce_no_prediction() {
    let mut p = StrokePredictor::default();
    assert_eq!(p.predict(10.0).unwrap(), None);
    p.push(sample(0.0, 0.0, 0.0)).unwrap();
    assert_eq!(p.predict(8.0).unwrap(), None);
    p.push(sample(8.0, 0.0, 8.0)).unwrap();
    assert_eq!(p.predict(8.0).unwrap(), None);
}

#[test]
fn irregular_sampling_and_epoch_clock_preserve_constant_velocity() {
    let mut p = StrokePredictor::new(PredictionOptions {
        max_distance: 100.0,
        ..Default::default()
    })
    .unwrap();
    let origin = 1_700_000_000_000.0;
    for t in [0.0, 5.0, 13.0, 20.0, 31.0] {
        p.push(sample(t * 0.5 + 100.0, t * -0.25, origin + t))
            .unwrap();
    }
    let result = p.predict(origin + 43.0).unwrap().unwrap();
    near_point(result.position, point(121.5, -10.75), 1e-9);
    assert_eq!(result.source_time_ms, origin + 31.0);
    assert_eq!(result.time_ms, origin + 43.0);
}

#[test]
fn prediction_queries_do_not_feed_back_into_history() {
    let (mut p, mut reference) = (StrokePredictor::default(), StrokePredictor::default());
    for s in [sample(0.0, 0.0, 0.0), sample(8.0, 4.0, 8.0)] {
        p.push(s).unwrap();
        reference.push(s).unwrap();
    }
    let before = p.predict(16.0).unwrap();
    assert_eq!(before, p.predict(16.0).unwrap());
    p.predict(20.0).unwrap();
    p.push(sample(16.0, 8.0, 16.0)).unwrap();
    reference.push(sample(16.0, 8.0, 16.0)).unwrap();
    assert_eq!(p.predict(24.0).unwrap(), reference.predict(24.0).unwrap());
}

#[test]
fn horizon_expires_and_distance_is_bounded() {
    let mut p = StrokePredictor::new(PredictionOptions {
        max_horizon_ms: 20.0,
        max_distance: 5.0,
        ..Default::default()
    })
    .unwrap();
    p.push(sample(0.0, 0.0, 0.0)).unwrap();
    p.push(sample(30.0, 40.0, 10.0)).unwrap();
    let next = p.predict(30.0).unwrap().unwrap().position;
    near((next.x - 30.0).hypot(next.y - 40.0), 5.0, 1e-10);
    assert_eq!(p.predict(31.0).unwrap(), None);
    assert!(p.predict(9.0).is_err());
}

#[test]
fn rounding_cannot_exceed_the_displacement_budget() {
    let origin = 9_007_199_254_740_992.0;
    let mut predictor = StrokePredictor::new(PredictionOptions {
        max_distance: 1.5,
        ..Default::default()
    })
    .unwrap();
    predictor.push(sample(origin - 2.0, 0.0, 0.0)).unwrap();
    predictor.push(sample(origin, 0.0, 10.0)).unwrap();
    let result = predictor.predict(20.0).unwrap();
    assert!(result.is_none_or(|p| (p.position.x - origin).hypot(p.position.y) <= 1.5));
}

#[test]
fn extreme_temporal_scale_does_not_distort_prediction_direction() {
    let step = f64::from_bits(1);
    let mut predictor = StrokePredictor::new(PredictionOptions {
        max_distance: 1e-16,
        max_horizon_ms: 1e308,
        ..Default::default()
    })
    .unwrap();
    predictor.push(sample(0.0, 0.0, 0.0)).unwrap();
    predictor.push(sample(step * 4.0, step * 4.0, 4.0)).unwrap();
    let result = predictor
        .predict(1e308)
        .unwrap()
        .expect("非零方向应能稳定归一化");
    assert!((result.position.x - step * 4.0).hypot(result.position.y - step * 4.0) <= 1e-16);
    near(result.position.x, result.position.y, 1e-30);
}

#[test]
fn stationary_sharp_turn_and_reversal_cancel_old_velocity() {
    for end in [
        sample(10.0, 0.0, 20.0),
        sample(10.0, 10.0, 20.0),
        sample(0.0, 0.0, 20.0),
    ] {
        let mut p = StrokePredictor::default();
        p.push(sample(0.0, 0.0, 0.0)).unwrap();
        p.push(sample(10.0, 0.0, 10.0)).unwrap();
        p.push(end).unwrap();
        assert_eq!(p.predict(28.0).unwrap(), None);
    }
}

#[test]
fn deceleration_caps_prediction_at_latest_observed_speed() {
    let mut p = StrokePredictor::new(PredictionOptions {
        max_distance: 100.0,
        ..Default::default()
    })
    .unwrap();
    for (t, x) in [(0.0, 0.0), (10.0, 10.0), (20.0, 20.0), (30.0, 22.0)] {
        p.push(sample(x, 0.0, t)).unwrap();
    }
    let x = p.predict(40.0).unwrap().unwrap().position.x;
    assert!(x > 22.0 && x <= 24.0 + 1e-10);
}

#[test]
fn pause_and_explicit_reset_clear_history() {
    let mut p = StrokePredictor::new(PredictionOptions {
        reset_gap_ms: 50.0,
        ..Default::default()
    })
    .unwrap();
    for s in [
        sample(0.0, 0.0, 0.0),
        sample(10.0, 0.0, 10.0),
        sample(100.0, 0.0, 100.0),
    ] {
        p.push(s).unwrap();
    }
    assert_eq!(p.predict(110.0).unwrap(), None);
    p.reset();
    p.push(sample(0.0, 0.0, 0.0)).unwrap();
    assert_eq!(p.predict(8.0).unwrap(), None);
}

#[test]
fn bounded_history_forgets_old_trajectory() {
    let mut p = StrokePredictor::new(PredictionOptions {
        history_size: 4,
        ..Default::default()
    })
    .unwrap();
    p.push(sample(-10000.0, -10000.0, 0.0)).unwrap();
    for i in 1..=10000 {
        p.push(sample(f64::from(i) * 8.0, 0.0, f64::from(i) * 8.0))
            .unwrap();
    }
    near_point(
        p.predict(80008.0).unwrap().unwrap().position,
        point(80008.0, 0.0),
        1e-8,
    );
}

#[test]
fn invalid_input_does_not_corrupt_history() {
    let mut p = StrokePredictor::default();
    p.push(sample(0.0, 0.0, 0.0)).unwrap();
    p.push(sample(8.0, 0.0, 8.0)).unwrap();
    let before = p.predict(16.0).unwrap();
    assert!(p.push(sample(2.0, 0.0, 8.0)).is_err());
    assert!(p.push(sample(f64::INFINITY, 0.0, 12.0)).is_err());
    assert!(p.predict(f64::NAN).is_err());
    assert_eq!(p.predict(16.0).unwrap(), before);
    let base = PredictionOptions::default();
    for options in [
        PredictionOptions {
            history_size: 1,
            ..base
        },
        PredictionOptions {
            history_size: 65,
            ..base
        },
        PredictionOptions {
            max_horizon_ms: 0.0,
            ..base
        },
        PredictionOptions {
            max_distance: -1.0,
            ..base
        },
        PredictionOptions {
            reset_gap_ms: f64::INFINITY,
            ..base
        },
    ] {
        assert!(StrokePredictor::new(options).is_err());
    }
}
