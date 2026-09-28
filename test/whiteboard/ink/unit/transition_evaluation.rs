//! 阶段划分依据信息可观测时间，不能要求预测器提前知道未来转向。
use super::*;

#[test]
fn boundary_position_is_not_a_post_change_observation() {
    assert_eq!(
        phase(20.0, Some(30.0), 20.0, 4.0),
        "pre_transition_crossing"
    );
    assert_eq!(phase(20.0, Some(30.0), 10.0, 4.0), "pre_transition_stable");
    assert_eq!(phase(20.0, Some(30.0), 30.0, 4.0), "response_0_16ms");
    assert_eq!(phase(20.0, Some(30.0), 46.0, 4.0), "response_16_32ms");
    assert_eq!(phase(20.0, Some(30.0), 62.0, 4.0), "response_32_64ms");
    assert_eq!(
        phase(20.0, None, 40.0, 4.0),
        "no_post_transition_observation"
    );
}

#[test]
fn pause_truth_has_a_stationary_interval_and_resumes_without_a_position_jump() {
    let motion = Motion {
        family: "pause".to_string(),
        speed: 0.6,
        angle: 0.0,
        center: [0.0, 0.0],
    };
    assert!((motion.position(150.0, 400.0).x - 80.0).abs() < 1e-12);
    assert_eq!(motion.position(150.0, 400.0), motion.position(250.0, 400.0));
    assert!((motion.position(280.0, 400.0).x - 88.0).abs() < 1e-12);
}
