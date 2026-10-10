#![cfg(target_os = "macos")]
#[allow(dead_code)]
#[path = "../../../../modules/agent/macos-ui/src/input.rs"]
mod input;
use objc2_app_kit::NSEvent;
use objc2_app_kit::NSEventType;
use objc2_core_foundation::CGPoint;
use objc2_core_graphics::{CGEvent, CGEventField};

#[test]
fn background_scroll_preserves_window_coordinates_and_pixel_deltas() {
    let target = input::WindowTarget::new(
        1234,
        5678,
        CGPoint {
            x: -500.0,
            y: 100.0,
        },
    )
    .unwrap();
    let point = CGPoint {
        x: -400.0,
        y: 220.0,
    };
    let event = input::scroll_event(target, point, -25.0, 100.0).unwrap();
    let native = NSEvent::eventWithCGEvent(&event).unwrap();
    assert_eq!(native.r#type(), NSEventType::ScrollWheel);
    assert_eq!(native.windowNumber(), 5678, "滚轮必须到达同一个已核验窗口");
    assert_eq!(native.scrollingDeltaX(), 25.0);
    assert_eq!(native.scrollingDeltaY(), -100.0);
    assert_eq!(
        input::window_location::get(&event).unwrap(),
        CGPoint { x: 100.0, y: 120.0 }
    );
    assert_eq!(CGEvent::location(Some(&event)), point);
}

#[test]
fn appkit_receives_the_bound_window_number_for_background_clicks() {
    let target = input::WindowTarget::new(
        1234,
        5678,
        CGPoint {
            x: -500.0,
            y: 100.0,
        },
    )
    .unwrap();
    let point = CGPoint {
        x: -400.0,
        y: 220.0,
    };
    for (button, number) in [("left", 0), ("right", 1), ("middle", 2)] {
        let pair = input::pointer_events(target, point, button, 2).unwrap();
        for event in &pair {
            let native = NSEvent::eventWithCGEvent(event).unwrap();
            assert_eq!(
                native.windowNumber(),
                5678,
                "AppKit 必须识别已绑定的目标窗口"
            );
            assert_eq!(native.buttonNumber(), number);
            assert_eq!(native.clickCount(), 2);
            assert_eq!(CGEvent::location(Some(event)), point);
            assert_eq!(
                input::window_location::get(event).unwrap(),
                CGPoint { x: 100.0, y: 120.0 },
                "屏幕坐标与窗口局部坐标必须同时绑定"
            );
        }
    }
}

#[test]
fn user_double_click_emits_two_pairs_and_preserves_the_second_click_state() {
    let target = input::WindowTarget::new(1234, 5678, CGPoint::ZERO).unwrap();
    let point = CGPoint { x: 20.0, y: 30.0 };
    let first = input::pointer_events(target, point, "left", 1).unwrap();
    let second = input::pointer_events(target, point, "left", 2).unwrap();
    assert_eq!(
        first.len() + second.len(),
        4,
        "用户的两个 click 回执必须对应两次按下和两次释放"
    );
    for event in &second {
        assert_eq!(
            CGEvent::integer_value_field(Some(event), CGEventField::MouseEventClickState),
            2
        );
        assert_eq!(
            CGEvent::integer_value_field(Some(event), CGEventField::EventTargetUnixProcessID),
            1234
        );
    }
}

#[test]
fn background_events_bind_both_process_and_real_window_without_changing_coordinates() {
    let target = input::WindowTarget::new(1234, 5678, CGPoint::ZERO).unwrap();
    let point = CGPoint {
        x: -400.0,
        y: 220.0,
    };
    let [mouse, _] = input::pointer_events(target, point, "left", 1).unwrap();
    let key = CGEvent::new_keyboard_event(None, 0, true).unwrap();
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
    assert!(input::WindowTarget::new(0, 5678, CGPoint::ZERO).is_err());
    assert!(input::WindowTarget::new(1234, 0, CGPoint::ZERO).is_err());
    assert!(
        input::WindowTarget::new(
            1234,
            5678,
            CGPoint {
                x: f64::NAN,
                y: 0.0
            }
        )
        .is_err()
    );
}
