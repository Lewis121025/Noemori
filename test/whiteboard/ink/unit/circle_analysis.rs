//! 圆拟合必须区分点到边界的残差与圆心/半径对扰动的敏感性。
#[path = "../support/mod.rs"]
mod support;
use nous_ink::{analyze_circle, fit_circle, Point};
use support::*;

fn noisy_arc(degrees: f64) -> Vec<Point> {
    let mut state = 11_u64;
    let mut noise = || {
        state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ((state >> 11) as f64 / (1_u64 << 53) as f64 * 2.0 - 1.0) * 0.05
    };
    (0..80)
        .map(|i| {
            let angle = (f64::from(i) / 79.0 - 0.5) * degrees.to_radians();
            point(80.0 * angle.cos() + noise(), 80.0 * angle.sin() + noise())
        })
        .collect()
}

#[test]
fn complete_circle_has_the_expected_dimensionless_sensitivity() {
    let input = circle(80.0, 128);
    let analysis = analyze_circle(&input).unwrap().unwrap();
    let sensitivity = analysis.sensitivity.unwrap();
    near(sensitivity.condition_number, 2.0_f64.sqrt(), 1e-10);
    near(sensitivity.parameter_amplification, 2.0_f64.sqrt(), 1e-10);
    assert!(sensitivity.relative_residual_sensitivity < 1e-12);
    assert_eq!(analysis.fit, fit_circle(&input).unwrap().unwrap());
}

#[test]
fn small_residual_does_not_hide_unstable_short_arc_parameters() {
    let short = analyze_circle(&noisy_arc(5.0)).unwrap().unwrap();
    let full = analyze_circle(&noisy_arc(360.0)).unwrap().unwrap();
    assert!(short.fit.rms_deviation < 0.04);
    let short = short.sensitivity.unwrap();
    let full = full.sensitivity.unwrap();
    assert!(short.parameter_amplification > full.parameter_amplification * 1000.0);
    assert!(short.relative_residual_sensitivity > full.relative_residual_sensitivity * 1000.0);
}

#[test]
fn sensitivity_is_invariant_under_similarity_transforms() {
    let input = noisy_arc(30.0);
    let baseline = analyze_circle(&input)
        .unwrap()
        .unwrap()
        .sensitivity
        .unwrap();
    let angle: f64 = 0.73;
    for scale in [0.01, 1.0, 100.0] {
        let transformed: Vec<_> = input
            .iter()
            .map(|p| {
                point(
                    scale * (p.x * angle.cos() - p.y * angle.sin()) + 500.0,
                    scale * (p.x * angle.sin() + p.y * angle.cos()) - 300.0,
                )
            })
            .collect();
        let actual = analyze_circle(&transformed)
            .unwrap()
            .unwrap()
            .sensitivity
            .unwrap();
        near(
            actual.condition_number / baseline.condition_number,
            1.0,
            1e-6,
        );
        near(
            actual.parameter_amplification / baseline.parameter_amplification,
            1.0,
            1e-6,
        );
        near(
            actual.relative_residual_sensitivity / baseline.relative_residual_sensitivity,
            1.0,
            1e-6,
        );
    }
}

#[test]
fn duplicated_observations_cannot_manufacture_more_geometric_evidence() {
    let points = noisy_arc(30.0);
    let repeated: Vec<_> = points
        .iter()
        .flat_map(|p| std::iter::repeat_n(*p, 10))
        .collect();
    let original = analyze_circle(&points).unwrap().unwrap();
    let duplicated = analyze_circle(&repeated).unwrap().unwrap();
    assert_eq!(original.fit.geometry, duplicated.fit.geometry);
    assert_eq!(original.sensitivity, duplicated.sensitivity);
}

#[test]
fn circle_analysis_retains_degenerate_and_invalid_input_contracts() {
    assert!(analyze_circle(&[point(0.0, 0.0), point(1.0, 1.0)])
        .unwrap()
        .is_none());
    assert!(
        analyze_circle(&[point(0.0, 0.0), point(1.0, 1.0), point(2.0, 2.0)])
            .unwrap()
            .is_none()
    );
    assert!(analyze_circle(&[point(f64::NAN, 0.0)]).is_err());
}
