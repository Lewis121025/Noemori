//! 评测器自身必须守住真值边界，防止插值穿过长暂停或抬笔。
use super::*;

#[test]
fn reference_is_bounded_by_real_observations_and_maximum_gap() {
    let stroke = [[0.0, 0.0, 0.0], [8.0, 4.0, 8.0], [48.0, 24.0, 48.0]];
    assert_eq!(reference(&stroke, 4.0), Some(Point { x: 4.0, y: 2.0 }));
    assert_eq!(reference(&stroke, 16.0), None);
    assert_eq!(reference(&stroke, 48.0), Some(Point { x: 48.0, y: 24.0 }));
    assert_eq!(reference(&stroke, 49.0), None);
    assert_eq!(reference(&stroke, -1.0), None);
}

#[test]
fn coalescing_preserves_last_position_for_duplicate_event_times() {
    assert_eq!(
        unique_times(vec![[1.0, 2.0, 3.0], [4.0, 5.0, 3.0], [6.0, 7.0, 8.0]]),
        vec![[4.0, 5.0, 3.0], [6.0, 7.0, 8.0]]
    );
}

#[test]
fn abstention_is_scored_as_holding_the_last_observation() {
    let input = sample([2.0, 3.0, 0.0]);
    let mut predictor = StrokePredictor::default();
    predictor.push(input).unwrap();
    let mut score = Scores::default();
    score.observe(&predictor, input, 8.0, Point { x: 5.0, y: 7.0 }, 10.0);
    assert_eq!(score.predictions, 0);
    assert_eq!(score.errors, vec![5.0]);
    assert_eq!(score.hold_errors, vec![5.0]);
    assert_eq!(score.relative_errors, vec![0.5]);
}

#[test]
fn rectangle_parameter_error_is_invariant_to_corner_order() {
    let a = corners(Point { x: 0.0, y: 0.0 }, 80.0, 40.0, 0.0);
    let b = corners(
        Point { x: 0.0, y: 0.0 },
        40.0,
        80.0,
        std::f64::consts::FRAC_PI_2,
    );
    assert!(symmetric_distance(&a, &b) < 1e-12);
}
