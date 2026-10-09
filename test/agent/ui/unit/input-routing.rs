#![cfg(target_os = "macos")]
#[allow(dead_code)]
#[path = "../../../../modules/agent/macos-ui/src/input.rs"]
mod input;
use objc2_core_foundation::CGPoint;
use objc2_core_graphics::{CGEvent, CGEventField, CGEventType, CGMouseButton};

#[test]
fn background_events_bind_both_process_and_real_window_without_changing_coordinates() {
    let target = input::WindowTarget::new(1234, 5678).unwrap();
    let point = CGPoint {
        x: -400.0,
        y: 220.0,
    };
    let mouse =
        CGEvent::new_mouse_event(None, CGEventType::LeftMouseDown, point, CGMouseButton::Left)
            .unwrap();
    let key = CGEvent::new_keyboard_event(None, 0, true).unwrap();
    target.route(&mouse);
    input::ProcessTarget::new(1234).unwrap().route(&key);
    for event in [&mouse, &key] {
        assert_eq!(
            CGEvent::integer_value_field(Some(event), CGEventField::EventTargetUnixProcessID),
            1234
        );
    }
    assert_eq!(
        CGEvent::integer_value_field(
            Some(&mouse),
            CGEventField::MouseEventWindowUnderMousePointer
        ),
        5678
    );
    assert_eq!(
        CGEvent::integer_value_field(
            Some(&mouse),
            CGEventField::MouseEventWindowUnderMousePointerThatCanHandleThisEvent
        ),
        5678
    );
    assert_eq!(CGEvent::location(Some(&mouse)), point);
    assert!(input::WindowTarget::new(0, 5678).is_err());
    assert!(input::WindowTarget::new(1234, 0).is_err());
}
