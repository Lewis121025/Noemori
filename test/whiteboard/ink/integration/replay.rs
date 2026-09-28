//! 内核组合使用时真实数据、预测和几何修正保持隔离。
#[path = "../support/mod.rs"]
mod support;
use nous_ink::{
    correct_stroke, snap_axes, Axis, AxisGuide, CorrectionOptions, OneEuroSmoother, Shape,
    StrokePredictor,
};
use support::*;

#[test]
fn prediction_display_frequency_does_not_change_real_input_processing() {
    let (mut sparse, mut frequent) = (StrokePredictor::default(), StrokePredictor::default());
    let (mut first, mut second) = (OneEuroSmoother::default(), OneEuroSmoother::default());
    let samples: Vec<_> = (0..240)
        .map(|i| {
            sample(
                f64::from(i) * 2.0,
                (f64::from(i) * 2.0).sin() * 0.05,
                f64::from(i) * 8.0,
            )
        })
        .collect();
    let original = samples.clone();
    for s in &samples {
        sparse.push(*s).unwrap();
        frequent.push(*s).unwrap();
        for horizon in [1.0, 4.0, 8.0, 12.0, 16.0] {
            frequent.predict(s.time_ms + horizon).unwrap();
        }
        assert_eq!(
            sparse.predict(s.time_ms + 16.0).unwrap(),
            frequent.predict(s.time_ms + 16.0).unwrap()
        );
        assert_eq!(first.push(*s).unwrap(), second.push(*s).unwrap());
    }
    let points: Vec<_> = samples.iter().map(|s| s.position).collect();
    let result = correct_stroke(
        &points,
        CorrectionOptions {
            shape: Shape::Line,
            max_deviation: 0.1,
        },
    )
    .unwrap()
    .unwrap();
    assert_eq!(result.points.len(), points.len());
    assert_eq!(samples, original);
}

#[test]
fn returned_values_do_not_alias_internal_state() {
    let mut predictor = StrokePredictor::default();
    let mut input = sample(0.0, 0.0, 0.0);
    predictor.push(input).unwrap();
    input.position.x = 1000.0;
    predictor.push(sample(8.0, 0.0, 8.0)).unwrap();
    let mut prediction = predictor.predict(16.0).unwrap().unwrap();
    prediction.position.x = -1000.0;
    near(
        predictor.predict(16.0).unwrap().unwrap().position.x,
        16.0,
        1e-10,
    );
    assert_eq!(input.position.x, 1000.0);
    assert_eq!(prediction.position.x, -1000.0);
}

#[test]
fn independent_strokes_can_restart_their_clock() {
    let mut p = StrokePredictor::default();
    let mut smoother = OneEuroSmoother::default();
    for offset in [0.0, 10000.0, -10000.0] {
        p.reset();
        smoother.reset();
        for s in [
            sample(offset, offset, 0.0),
            sample(offset + 5.0, offset + 5.0, 10.0),
        ] {
            p.push(s).unwrap();
            smoother.push(s).unwrap();
        }
        near_point(
            p.predict(20.0).unwrap().unwrap().position,
            point(offset + 10.0, offset + 10.0),
            1e-10,
        );
    }
}

#[test]
fn viewport_conversion_is_owned_by_the_caller() {
    let guides = [AxisGuide {
        id: "edge",
        axis: Axis::X,
        value: 10.0,
    }];
    assert!(snap_axes(point(4.0, 0.0), &guides, 8.0).unwrap().is_some());
    assert!(snap_axes(point(4.0, 0.0), &guides, 8.0 / 2.0)
        .unwrap()
        .is_none());
}
