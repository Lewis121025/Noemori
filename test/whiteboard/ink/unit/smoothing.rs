//! 自适应平滑的行为与状态契约。
#[path = "../support/mod.rs"]
mod support;
use nous_ink::{OneEuroSmoother, SmoothingOptions};
use support::*;

#[test]
fn first_sample_preserves_position_time_and_pressure() {
    let mut smoother = OneEuroSmoother::default();
    let mut input = sample(10.0, -20.0, 0.0);
    input.pressure = Some(0.7);
    assert_eq!(smoother.push(input).unwrap(), input);
    assert_eq!(
        smoother.push(sample(10.0, -20.0, 8.0)).unwrap().pressure,
        None
    );
}

#[test]
fn stationary_jitter_energy_is_reduced() {
    let mut smoother = OneEuroSmoother::default();
    let (mut raw, mut filtered) = (0.0, 0.0);
    for i in 0..160 {
        let x = (f64::from(i) * 2.3).sin();
        let y = (f64::from(i) * 2.1).cos();
        let p = smoother
            .push(sample(x, y, f64::from(i) * 8.0))
            .unwrap()
            .position;
        if i > 30 {
            raw += x * x + y * y;
            filtered += p.x * p.x + p.y * p.y;
        }
    }
    assert!(filtered < raw * 0.15);
}

#[test]
fn speed_adaptation_reduces_lag() {
    let mut adaptive = OneEuroSmoother::new(SmoothingOptions {
        beta: 0.1,
        ..Default::default()
    })
    .unwrap();
    let mut fixed = OneEuroSmoother::new(SmoothingOptions {
        beta: 0.0,
        ..Default::default()
    })
    .unwrap();
    let (mut a, mut b) = (0.0, 0.0);
    for i in 0..80 {
        let input = sample(f64::from(i) * 5.0, 0.0, f64::from(i) * 8.0);
        a = input.position.x - adaptive.push(input).unwrap().position.x;
        b = input.position.x - fixed.push(input).unwrap().position.x;
    }
    assert!(a < b * 0.3);
}

#[test]
fn filtering_is_rotation_equivariant() {
    let (mut first, mut second) = (OneEuroSmoother::default(), OneEuroSmoother::default());
    let angle: f64 = 0.63;
    for i in 0..40 {
        let p = sample(
            f64::from(i) * 2.0,
            (f64::from(i) / 4.0).sin() * 7.0,
            f64::from(i) * 8.0,
        );
        let a = first.push(p).unwrap().position;
        let b = second
            .push(sample(
                p.position.x * angle.cos() - p.position.y * angle.sin(),
                p.position.x * angle.sin() + p.position.y * angle.cos(),
                p.time_ms,
            ))
            .unwrap()
            .position;
        near_point(
            b,
            point(
                a.x * angle.cos() - a.y * angle.sin(),
                a.x * angle.sin() + a.y * angle.cos(),
            ),
            1e-9,
        );
    }
}

#[test]
fn pause_and_reset_start_a_new_stroke() {
    let mut smoother = OneEuroSmoother::new(SmoothingOptions {
        reset_gap_ms: 100.0,
        ..Default::default()
    })
    .unwrap();
    smoother.push(sample(0.0, 0.0, 0.0)).unwrap();
    let next = sample(100.0, 200.0, 101.0);
    assert_eq!(smoother.push(next).unwrap(), next);
    smoother.reset();
    assert_eq!(
        smoother.push(sample(-5.0, 3.0, 0.0)).unwrap().position.x,
        -5.0
    );
}

#[test]
fn invalid_sample_does_not_mutate_filter_state() {
    let (mut smoother, mut reference) = (OneEuroSmoother::default(), OneEuroSmoother::default());
    smoother.push(sample(0.0, 0.0, 10.0)).unwrap();
    reference.push(sample(0.0, 0.0, 10.0)).unwrap();
    let mut bad_pressure = sample(1.0, 0.0, 20.0);
    bad_pressure.pressure = Some(1.1);
    for bad in [
        sample(f64::NAN, 0.0, 20.0),
        sample(1.0, 0.0, 10.0),
        sample(1.0, 0.0, 9.0),
        bad_pressure,
    ] {
        assert!(smoother.push(bad).is_err());
    }
    let next = sample(10.0, 2.0, 20.0);
    assert_eq!(smoother.push(next).unwrap(), reference.push(next).unwrap());
}

#[test]
fn invalid_options_are_rejected() {
    let base = SmoothingOptions::default();
    for options in [
        SmoothingOptions {
            min_cutoff: 0.0,
            ..base
        },
        SmoothingOptions { beta: -1.0, ..base },
        SmoothingOptions {
            derivative_cutoff: f64::INFINITY,
            ..base
        },
        SmoothingOptions {
            reset_gap_ms: 0.0,
            ..base
        },
    ] {
        assert!(OneEuroSmoother::new(options).is_err());
    }
}

#[test]
fn arithmetic_overflow_does_not_commit_partial_filter_state() {
    let (mut smoother, mut reference) = (OneEuroSmoother::default(), OneEuroSmoother::default());
    smoother.push(sample(0.0, 0.0, 0.0)).unwrap();
    reference.push(sample(0.0, 0.0, 0.0)).unwrap();
    assert!(smoother.push(sample(f64::MAX, 0.0, 1.0)).is_err());
    let next = sample(1.0, 2.0, 10.0);
    assert_eq!(smoother.push(next).unwrap(), reference.push(next).unwrap());
}
