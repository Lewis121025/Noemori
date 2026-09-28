//! 几何拟合、数值稳定性和硬偏移上限。
#[path = "../support/mod.rs"]
mod support;
use nous_ink::{
    correct_stroke, fit_circle, fit_line, fit_rectangle, CorrectionOptions, Geometry, Shape,
};
use support::*;

#[test]
fn vertical_line_preserves_stroke_direction() {
    let result = fit_line(&[point(4.0, 10.0), point(4.0, 5.0), point(4.0, -2.0)])
        .unwrap()
        .unwrap();
    near_point(result.geometry.start, point(4.0, 10.0), 1e-10);
    near_point(result.geometry.end, point(4.0, -2.0), 1e-10);
    assert!(result.max_deviation < 1e-10);
}

#[test]
fn exact_vertical_line_accepts_zero_displacement_budget() {
    let points = [point(0.0, 0.0), point(0.0, 5.0), point(0.0, 10.0)];
    let result = correct_stroke(
        &points,
        CorrectionOptions {
            shape: Shape::Line,
            max_deviation: 0.0,
        },
    )
    .unwrap()
    .expect("精确竖线不需要任何位移");
    assert_eq!(result.points, points);
    assert_eq!(result.max_deviation, 0.0);
}

#[test]
fn circle_fit_survives_large_translation() {
    let points: Vec<_> = circle(25.0, 80)
        .into_iter()
        .map(|p| point(p.x + 1e9, p.y - 1e9))
        .collect();
    let result = fit_circle(&points).unwrap().unwrap();
    near_point(
        result.geometry.center,
        point(1e9 + 100.0, -1e9 - 50.0),
        1e-5,
    );
    near(result.geometry.radius, 25.0, 1e-5);
    assert!(result.max_deviation < 1e-5);
}

#[test]
fn sparse_irregular_arc_keeps_original_supporting_circle() {
    let result = fit_circle(&[point(1.0, 0.0), point(0.6, 0.8), point(-1.0, 0.0)])
        .unwrap()
        .unwrap();
    near_point(result.geometry.center, point(0.0, 0.0), 1e-10);
    near(result.geometry.radius, 1.0, 1e-10);
    assert!(result.max_deviation < 1e-10);
}

#[test]
fn rectangle_supports_rotation_and_square_symmetry() {
    for angle in [0.0, 0.37, std::f64::consts::FRAC_PI_2, 2.8] {
        let result = fit_rectangle(&rectangle(angle)).unwrap().unwrap();
        near_point(result.geometry.center, point(200.0, 100.0), 1e-8);
        near(result.geometry.width * result.geometry.height, 3200.0, 1e-6);
        assert!(result.max_deviation < 1e-8);
    }
    let result = fit_rectangle(&[
        point(0.0, 5.0),
        point(5.0, 0.0),
        point(0.0, -5.0),
        point(-5.0, 0.0),
        point(0.0, 5.0),
    ])
    .unwrap()
    .unwrap();
    assert!(result.max_deviation < 1e-8);
}

#[test]
fn four_exact_rectangle_corners_need_no_iterative_adjustment() {
    let points = [
        point(-4.0, -2.0),
        point(4.0, -2.0),
        point(4.0, 2.0),
        point(-4.0, 2.0),
    ];
    let result = correct_stroke(
        &points,
        CorrectionOptions {
            shape: Shape::Rectangle,
            max_deviation: 0.0,
        },
    )
    .unwrap()
    .expect("已经准确的矩形不应因样本少于优化参数而被拒绝");
    assert_eq!(result.points, points);
}

#[test]
fn degenerate_strokes_and_non_finite_points_are_distinct() {
    for shape in [Shape::Line, Shape::Circle, Shape::Rectangle] {
        let options = CorrectionOptions {
            shape,
            max_deviation: 1.0,
        };
        assert!(correct_stroke(&[], options).unwrap().is_none());
        assert!(correct_stroke(&[point(1.0, 2.0); 2], options)
            .unwrap()
            .is_none());
        assert!(correct_stroke(&[point(f64::NAN, 0.0)], options).is_err());
    }
    let line = [point(0.0, 0.0), point(1.0, 1.0), point(2.0, 2.0)];
    assert!(fit_circle(&line).unwrap().is_none());
    assert!(fit_rectangle(&line).unwrap().is_none());
}

#[test]
fn correction_preserves_input_and_enforces_maximum_displacement() {
    let points: Vec<_> = (0..40)
        .map(|i| point(f64::from(i) * 3.0, (f64::from(i) * 2.1).sin() * 0.4))
        .collect();
    let original = points.clone();
    let result = correct_stroke(
        &points,
        CorrectionOptions {
            shape: Shape::Line,
            max_deviation: 0.6,
        },
    )
    .unwrap()
    .unwrap();
    assert_eq!(result.points.len(), points.len());
    assert!(result.max_deviation <= 0.6);
    for (p, source) in result.points.iter().zip(&points) {
        assert!((p.x - source.x).hypot(p.y - source.y) <= 0.6);
    }
    assert!(correct_stroke(
        &points,
        CorrectionOptions {
            shape: Shape::Line,
            max_deviation: 0.01
        }
    )
    .unwrap()
    .is_none());
    assert_eq!(points, original);
}

#[test]
fn correction_projects_onto_circle_and_rectangle_boundaries() {
    let points: Vec<_> = circle(30.0, 80)
        .into_iter()
        .enumerate()
        .map(|(i, p)| {
            point(
                p.x + (i as f64 * 3.0).sin() * 0.05,
                p.y + (i as f64 * 2.0).cos() * 0.05,
            )
        })
        .collect();
    let result = correct_stroke(
        &points,
        CorrectionOptions {
            shape: Shape::Circle,
            max_deviation: 0.2,
        },
    )
    .unwrap()
    .unwrap();
    let Geometry::Circle(circle) = result.geometry else {
        panic!("未返回圆");
    };
    for p in result.points {
        near(
            (p.x - circle.center.x).hypot(p.y - circle.center.y),
            circle.radius,
            1e-8,
        );
    }
    let result = correct_stroke(
        &rectangle(0.4),
        CorrectionOptions {
            shape: Shape::Rectangle,
            max_deviation: 1e-6,
        },
    )
    .unwrap()
    .unwrap();
    assert!(result.max_deviation < 1e-6);
}

#[test]
fn low_average_error_does_not_hide_an_outlier() {
    let mut points: Vec<_> = (0..100).map(|i| point(f64::from(i), 0.0)).collect();
    points[50] = point(50.0, 20.0);
    assert!(correct_stroke(
        &points,
        CorrectionOptions {
            shape: Shape::Line,
            max_deviation: 1.0
        }
    )
    .unwrap()
    .is_none());
}

#[test]
fn tolerances_scale_with_input_coordinates() {
    let points = [point(0.0, 0.0), point(5.0, 0.1), point(10.0, 0.0)];
    let small = correct_stroke(
        &points,
        CorrectionOptions {
            shape: Shape::Line,
            max_deviation: 0.2,
        },
    )
    .unwrap()
    .unwrap();
    let scaled: Vec<_> = points
        .iter()
        .map(|p| point(p.x * 100.0, p.y * 100.0))
        .collect();
    let large = correct_stroke(
        &scaled,
        CorrectionOptions {
            shape: Shape::Line,
            max_deviation: 20.0,
        },
    )
    .unwrap()
    .unwrap();
    near(large.max_deviation, small.max_deviation * 100.0, 1e-8);
    assert!(correct_stroke(
        &points,
        CorrectionOptions {
            shape: Shape::Line,
            max_deviation: -1.0
        }
    )
    .is_err());
}

#[test]
fn finite_inputs_with_unrepresentable_span_return_an_error() {
    let points = [point(-f64::MAX, 0.0), point(f64::MAX, 1.0)];
    assert!(fit_line(&points).is_err());
    assert!(fit_circle(&points).is_err());
    assert!(fit_rectangle(&points).is_err());
}
