#[path = "../../../../modules/agent/macos-ui/src/geometry.rs"]
mod geometry;
use geometry::{Bounds, PixelMapping};

#[test]
fn retina_scaling_and_negative_display_coordinates_use_actual_capture_range() {
    let mapping = PixelMapping {
        bounds: Bounds {
            x: -1920.0,
            y: -300.0,
            width: 800.0,
            height: 600.0,
        },
        width: 1600,
        height: 1200,
    };
    assert_eq!(mapping.screen_point(800.0, 600.0).unwrap(), (-1520.0, 0.0));
    assert_eq!(mapping.bounds.json()["x"], -1920.0);
    let downsampled = PixelMapping {
        width: 400,
        height: 300,
        ..mapping
    };
    assert_eq!(
        downsampled.screen_point(200.0, 150.0).unwrap(),
        (-1520.0, 0.0)
    );
    assert!(mapping.screen_point(1600.0, 0.0).is_err());
    assert!(mapping.screen_point(-0.01, 1.0).is_err());
    assert!(mapping.screen_point(f64::NAN, 1.0).is_err());
    assert!(
        PixelMapping {
            width: 0,
            ..mapping
        }
        .screen_point(0.0, 0.0)
        .is_err()
    );
    assert!(
        PixelMapping {
            bounds: Bounds {
                width: 0.0,
                ..mapping.bounds
            },
            ..mapping
        }
        .screen_point(0.0, 0.0)
        .is_err()
    );
}
