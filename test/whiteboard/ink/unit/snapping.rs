//! 点吸附和单轴约束的确定性行为。
#[path = "../support/mod.rs"]
mod support;
use nous_ink::{snap_axes, snap_point, Axis, AxisGuide, SnapTarget};
use support::*;

#[test]
fn point_snapping_uses_euclidean_distance_and_stable_ties() {
    let targets = [
        SnapTarget {
            id: "far",
            position: point(5.0, 0.0),
        },
        SnapTarget {
            id: "near",
            position: point(3.0, 4.0),
        },
    ];
    assert!(snap_point(point(0.0, 0.0), &targets, 4.99)
        .unwrap()
        .is_none());
    let result = snap_point(point(0.0, 0.0), &targets, 5.0).unwrap().unwrap();
    assert_eq!(result.target_id, "far");
    assert_eq!(result.position, point(5.0, 0.0));
    assert_eq!(result.offset, point(5.0, 0.0));
}

#[test]
fn axes_snap_independently_with_stable_ties() {
    let guides = [
        AxisGuide {
            id: "left",
            axis: Axis::X,
            value: 8.0,
        },
        AxisGuide {
            id: "right",
            axis: Axis::X,
            value: 12.0,
        },
        AxisGuide {
            id: "top",
            axis: Axis::Y,
            value: 19.0,
        },
    ];
    let result = snap_axes(point(10.0, 20.0), &guides, 2.0).unwrap().unwrap();
    assert_eq!(result.position, point(8.0, 19.0));
    assert_eq!(result.offset, point(-2.0, -1.0));
    assert_eq!(result.x_guide_id, Some("left"));
    assert_eq!(result.y_guide_id, Some("top"));
}

#[test]
fn unmatched_axes_keep_the_original_coordinate() {
    let guides = [AxisGuide {
        id: "x",
        axis: Axis::X,
        value: 1.0,
    }];
    let result = snap_axes(point(0.0, 10.0), &guides, 2.0).unwrap().unwrap();
    assert_eq!(result.position, point(1.0, 10.0));
    assert_eq!(result.y_guide_id, None);
    assert!(snap_axes(point(0.0, 0.0), &[], 0.0).unwrap().is_none());
    assert!(snap_point(point(0.0, 0.0), &[], 0.0).unwrap().is_none());
}

#[test]
fn all_targets_are_validated_even_after_a_perfect_match() {
    let targets = [
        SnapTarget {
            id: "ok",
            position: point(0.0, 0.0),
        },
        SnapTarget {
            id: "bad",
            position: point(f64::INFINITY, 0.0),
        },
    ];
    assert!(snap_point(point(0.0, 0.0), &targets, 1.0).is_err());
    assert!(snap_axes(
        point(0.0, 0.0),
        &[AxisGuide {
            id: "bad",
            axis: Axis::X,
            value: f64::NAN
        }],
        1.0
    )
    .is_err());
    assert!(snap_point(point(0.0, 0.0), &[], -1.0).is_err());
}
