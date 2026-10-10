//! 输入直接投递给已验证的目标进程，不进入系统全局事件队列或移动用户光标。
use objc2_app_kit::{NSEvent, NSEventModifierFlags, NSEventType};
use objc2_core_foundation::{CFRetained, CFRunLoop, CGPoint, kCFRunLoopDefaultMode};
use objc2_core_graphics::*;
use objc2_foundation::NSProcessInfo;
use std::time::Duration;
#[path = "window-location.rs"]
pub(crate) mod window_location;

/// 后台输入只需要事件发送权限；用户在其他应用的输入不撤销目标窗口授权。
pub(crate) fn permitted() -> bool {
    CGPreflightPostEventAccess()
}
/// 独立报告旧界面中的监听权限，后台输入不依赖该权限。
pub(crate) fn monitoring_permitted() -> bool {
    CGPreflightListenEventAccess()
}
/// 有界处理系统回调，避免截图或连续输入期间阻塞当前线程。
pub(crate) fn pump() {
    // SAFETY: 使用系统默认模式，当前线程以有界时长驱动自己的 run loop。
    unsafe {
        CFRunLoop::run_in_mode(kCFRunLoopDefaultMode, 0.001, true);
    }
}
/// 键盘按进程投递；应用内部的输入窗口由 Service 每次发送前核验。
#[derive(Clone, Copy)]
pub(crate) struct ProcessTarget {
    pid: i32,
}
impl ProcessTarget {
    /// 只接受当前存活应用实例的正 PID，非法目标在创建事件前拒绝。
    pub(crate) fn new(pid: i32) -> Result<Self, String> {
        if pid <= 0 {
            return Err("后台输入进程无效".into());
        }
        Ok(Self { pid })
    }
    /// 将事件绑定进程，不依赖键盘事件不支持的鼠标窗口字段。
    pub(crate) fn route(self, event: &CGEvent) {
        CGEvent::set_integer_value_field(
            Some(event),
            CGEventField::EventTargetUnixProcessID,
            i64::from(self.pid),
        );
    }
}
/// 鼠标坐标还需要截图确认的真实窗口编号，不能只按进程焦点猜测窗口。
#[derive(Clone, Copy)]
pub(crate) struct WindowTarget {
    process: ProcessTarget,
    window: u32,
    origin: CGPoint,
}
impl WindowTarget {
    /// 目标必须同时具有有效进程、非零截图窗口编号和已核验的窗口左上角。
    pub(crate) fn new(pid: i32, window: u32, origin: CGPoint) -> Result<Self, String> {
        if window == 0 || !origin.x.is_finite() || !origin.y.is_finite() {
            return Err("后台输入窗口无效".into());
        }
        Ok(Self {
            process: ProcessTarget::new(pid)?,
            window,
            origin,
        })
    }
    /// 本模块的定位事件共用窗口元数据；键盘事件由进程内已核验的输入窗口接收。
    pub(crate) fn route(self, event: &CGEvent) {
        self.process.route(event);
        for field in [
            CGEventField::MouseEventWindowUnderMousePointer,
            CGEventField::MouseEventWindowUnderMousePointerThatCanHandleThisEvent,
        ] {
            CGEvent::set_integer_value_field(Some(event), field, i64::from(self.window));
        }
    }
}
fn source() -> Result<CFRetained<CGEventSource>, String> {
    CGEventSource::new(CGEventSourceStateID::Private).ok_or_else(|| "不能创建独立输入源".into())
}
fn post(target: ProcessTarget, event: &CGEvent, dispatched: &mut bool) {
    *dispatched = true;
    target.route(event);
    CGEvent::post_to_pid(target.pid, Some(event));
}
/// AppKit 的窗口编号与 CG 的“鼠标下方窗口”不是同一字段，必须经公开的原生事件桥接建立。
/// 屏幕点与窗口局部点分别绑定；Helper 没有目标 NSWindow，不能让 AppKit 猜测其局部坐标。
fn window_event(
    target: WindowTarget,
    source: &CGEventSource,
    kind: CGEventType,
    point: CGPoint,
    button: CGMouseButton,
    clicks: i64,
) -> Result<CFRetained<CGEvent>, String> {
    let native_kind = match kind {
        CGEventType::LeftMouseDown => NSEventType::LeftMouseDown,
        CGEventType::LeftMouseUp => NSEventType::LeftMouseUp,
        CGEventType::LeftMouseDragged => NSEventType::LeftMouseDragged,
        CGEventType::RightMouseDown => NSEventType::RightMouseDown,
        CGEventType::RightMouseUp => NSEventType::RightMouseUp,
        CGEventType::OtherMouseDown => NSEventType::OtherMouseDown,
        CGEventType::OtherMouseUp => NSEventType::OtherMouseUp,
        CGEventType::ScrollWheel => NSEventType::MouseMoved,
        _ => return Err("原生鼠标事件类型无效".into()),
    };
    let native = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
        native_kind,
        CGPoint::ZERO,
        NSEventModifierFlags::empty(),
        NSProcessInfo::processInfo().systemUptime(),
        target.window as isize,
        None,
        0,
        clicks as isize,
        if matches!(kind, CGEventType::LeftMouseUp | CGEventType::RightMouseUp | CGEventType::OtherMouseUp) { 0.0 } else { 1.0 },
    ).ok_or("不能创建原生鼠标事件")?;
    let bridged = native.CGEvent().ok_or("不能桥接原生鼠标事件")?;
    let event = CGEvent::new_copy(Some(&bridged)).ok_or("不能复制原生鼠标事件")?;
    CGEvent::set_type(Some(&event), kind);
    CGEvent::set_source(Some(&event), Some(source));
    CGEvent::set_location(Some(&event), point);
    CGEvent::set_integer_value_field(
        Some(&event),
        CGEventField::MouseEventButtonNumber,
        button.0.into(),
    );
    target.route(&event);
    window_location::set(
        &event,
        CGPoint {
            x: point.x - target.origin.x,
            y: point.y - target.origin.y,
        },
    )?;
    Ok(event)
}
fn mouse(
    target: WindowTarget,
    source: &CGEventSource,
    kind: CGEventType,
    point: CGPoint,
    button: CGMouseButton,
    clicks: i64,
    dispatched: &mut bool,
) -> Result<(), String> {
    let event = window_event(target, source, kind, point, button, clicks)?;
    post(target.process, &event, dispatched);
    Ok(())
}
/// 按已核验的屏幕点发送点击；每次按下前调用 check，失败保留 dispatched 事实。
pub(crate) fn pointer(
    target: WindowTarget,
    point: CGPoint,
    button: &str,
    clicks: u32,
    check: impl Fn() -> Result<(), String>,
    dispatched: &mut bool,
) -> Result<(), String> {
    if !(1..=3).contains(&clicks) {
        return Err("点击次数无效".into());
    }
    for index in 1..=clicks {
        pointer_event(target, point, button, index, &check, dispatched)?;
    }
    Ok(())
}

/// 人工 click 已是一次完整手势；click_state 是连续点击编号，不能再重复派发。
/// target 与 point 已由宿主核验；参数、授权或系统分配失败返回错误，派发事实保留在 dispatched。
pub(crate) fn pointer_event(
    target: WindowTarget,
    point: CGPoint,
    button: &str,
    click_state: u32,
    check: impl Fn() -> Result<(), String>,
    dispatched: &mut bool,
) -> Result<(), String> {
    let [down, up] = pointer_events(target, point, button, click_state)?;
    check()?;
    post(target.process, &down, dispatched);
    post(target.process, &up, dispatched);
    check()
}

/// 先建立完整鼠标事件对，再派发；分配失败不能留下没有释放事件的按下状态。
/// target 与 point 已由宿主核验；非法按钮、次数或系统分配失败返回错误，不发送事件。
pub(crate) fn pointer_events(
    target: WindowTarget,
    point: CGPoint,
    button: &str,
    click_state: u32,
) -> Result<[CFRetained<CGEvent>; 2], String> {
    let (button, down, up) = match button {
        "left" => (
            CGMouseButton::Left,
            CGEventType::LeftMouseDown,
            CGEventType::LeftMouseUp,
        ),
        "right" => (
            CGMouseButton::Right,
            CGEventType::RightMouseDown,
            CGEventType::RightMouseUp,
        ),
        "middle" => (
            CGMouseButton::Center,
            CGEventType::OtherMouseDown,
            CGEventType::OtherMouseUp,
        ),
        _ => return Err("鼠标按钮无效".into()),
    };
    if !(1..=3).contains(&click_state) {
        return Err("点击序列编号无效".into());
    }
    let source = source()?;
    let pair = [down, up]
        .map(|kind| window_event(target, &source, kind, point, button, click_state.into()));
    let [down, up] = pair;
    let pair = [down?, up?];
    Ok(pair)
}
/// 拖动期间反复核验租约与取消状态，结束或失败都释放助手按下的鼠标。
pub(crate) fn drag(
    target: WindowTarget,
    from: CGPoint,
    to: CGPoint,
    check: impl Fn() -> Result<(), String>,
    dispatched: &mut bool,
) -> Result<(), String> {
    let source = source()?;
    check()?;
    mouse(
        target,
        &source,
        CGEventType::LeftMouseDown,
        from,
        CGMouseButton::Left,
        1,
        dispatched,
    )?;
    let mut last = from;
    let result = (|| {
        for index in 1..=30 {
            check()?;
            let t = f64::from(index) / 30.0;
            last = CGPoint {
                x: from.x + (to.x - from.x) * t,
                y: from.y + (to.y - from.y) * t,
            };
            mouse(
                target,
                &source,
                CGEventType::LeftMouseDragged,
                last,
                CGMouseButton::Left,
                1,
                dispatched,
            )?;
            std::thread::sleep(Duration::from_millis(10));
        }
        Ok(())
    })();
    let release = mouse(
        target,
        &source,
        CGEventType::LeftMouseUp,
        last,
        CGMouseButton::Left,
        1,
        dispatched,
    );
    result.and(release)
}
/// 按完整 Unicode 字符输入，每个字符前核验控制权；不拆分 UTF-16 代理对。
pub(crate) fn text(
    target: ProcessTarget,
    text: &str,
    check: impl Fn() -> Result<(), String>,
    dispatched: &mut bool,
) -> Result<(), String> {
    let source = source()?;
    for character in text.chars() {
        check()?;
        let mut encoded = [0; 2];
        let units = character.encode_utf16(&mut encoded);
        let down = CGEvent::new_keyboard_event(Some(&source), 0, true).ok_or("不能创建文本事件")?;
        // SAFETY: UTF-16 缓冲区在同步设置期间存活，长度来自有效编码结果，单个字符不拆代理对。
        unsafe {
            CGEvent::keyboard_set_unicode_string(Some(&down), units.len() as _, units.as_ptr());
        }
        let up =
            CGEvent::new_keyboard_event(Some(&source), 0, false).ok_or("不能创建文本释放事件")?;
        // SAFETY: 释放事件采用同一有效 UTF-16 字符，避免 keyup 暴露与中文输入不一致的键值。
        unsafe {
            CGEvent::keyboard_set_unicode_string(Some(&up), units.len() as _, units.as_ptr());
        }
        post(target, &down, dispatched);
        post(target, &up, dispatched);
    }
    Ok(())
}
fn key_code(key: &str) -> Option<u16> {
    match key.to_lowercase().as_str() {
        "a" => Some(0),
        "s" => Some(1),
        "d" => Some(2),
        "f" => Some(3),
        "h" => Some(4),
        "g" => Some(5),
        "z" => Some(6),
        "x" => Some(7),
        "c" => Some(8),
        "v" => Some(9),
        "b" => Some(11),
        "q" => Some(12),
        "w" => Some(13),
        "e" => Some(14),
        "r" => Some(15),
        "y" => Some(16),
        "t" => Some(17),
        "1" => Some(18),
        "2" => Some(19),
        "3" => Some(20),
        "4" => Some(21),
        "6" => Some(22),
        "5" => Some(23),
        "9" => Some(25),
        "7" => Some(26),
        "8" => Some(28),
        "0" => Some(29),
        "o" => Some(31),
        "u" => Some(32),
        "i" => Some(34),
        "p" => Some(35),
        "enter" | "return" => Some(36),
        "l" => Some(37),
        "j" => Some(38),
        "k" => Some(40),
        "n" => Some(45),
        "m" => Some(46),
        "tab" => Some(48),
        "space" => Some(49),
        "backspace" => Some(51),
        "escape" | "esc" => Some(53),
        "home" => Some(115),
        "end" => Some(119),
        "delete" => Some(117),
        "arrowleft" | "left" => Some(123),
        "arrowright" | "right" => Some(124),
        "arrowdown" | "down" => Some(125),
        "arrowup" | "up" => Some(126),
        _ => None,
    }
}
/// 解析受支持的按键组合后发送成对事件；未知按键、授权撤销或系统失败返回诊断。
pub(crate) fn key(
    target: ProcessTarget,
    key: &str,
    check: impl Fn() -> Result<(), String>,
    dispatched: &mut bool,
) -> Result<(), String> {
    let mut parts = key.split('+').collect::<Vec<_>>();
    let key = parts.pop().ok_or("键盘组合为空")?;
    let code = key_code(key).ok_or("键盘按键不受支持")?;
    let mut flags = CGEventFlags::empty();
    for modifier in parts {
        flags |= match modifier.to_lowercase().as_str() {
            "meta" | "cmd" | "command" => CGEventFlags::MaskCommand,
            "control" | "ctrl" => CGEventFlags::MaskControl,
            "alt" | "option" => CGEventFlags::MaskAlternate,
            "shift" => CGEventFlags::MaskShift,
            _ => return Err("键盘修饰键无效".into()),
        };
    }
    check()?;
    let source = source()?;
    let down = CGEvent::new_keyboard_event(Some(&source), code, true).ok_or("不能创建键盘事件")?;
    let up = CGEvent::new_keyboard_event(Some(&source), code, false).ok_or("不能创建释放事件")?;
    CGEvent::set_flags(Some(&down), flags);
    CGEvent::set_flags(Some(&up), flags);
    post(target, &down, dispatched);
    post(target, &up, dispatched);
    check()
}
/// 按网页滚轮方向在已核验窗口滚动，正值向右或下；无效滚动拒绝，派发事实通过 dispatched 返回。
pub(crate) fn scroll(
    target: WindowTarget,
    point: CGPoint,
    x: f64,
    y: f64,
    check: impl Fn() -> Result<(), String>,
    dispatched: &mut bool,
) -> Result<(), String> {
    check()?;
    let event = scroll_event(target, point, x, y)?;
    post(target.process, &event, dispatched);
    check()
}

/// 将网页滚轮方向转换为 macOS 原生轴方向；无效滚动量或系统分配失败直接返回错误。
pub(crate) fn scroll_event(
    target: WindowTarget,
    point: CGPoint,
    x: f64,
    y: f64,
) -> Result<CFRetained<CGEvent>, String> {
    if !x.is_finite() || !y.is_finite() || x.abs() > 100000.0 || y.abs() > 100000.0 {
        return Err("滚动量无效".into());
    }
    let source = source()?;
    let deltas = CGEvent::new_scroll_wheel_event2(
        Some(&source),
        CGScrollEventUnit::Pixel,
        2,
        (-y).round() as i32,
        (-x).round() as i32,
        0,
    )
    .ok_or("不能创建滚动事件")?;
    let event = window_event(
        target,
        &source,
        CGEventType::ScrollWheel,
        point,
        CGMouseButton::Left,
        0,
    )?;
    // 像素、行和固定点增量由系统的滚轮构造器统一生成，避免自行推断滚动单位转换。
    for field in [
        CGEventField::ScrollWheelEventDeltaAxis1,
        CGEventField::ScrollWheelEventDeltaAxis2,
        CGEventField::ScrollWheelEventDeltaAxis3,
        CGEventField::ScrollWheelEventFixedPtDeltaAxis1,
        CGEventField::ScrollWheelEventFixedPtDeltaAxis2,
        CGEventField::ScrollWheelEventFixedPtDeltaAxis3,
        CGEventField::ScrollWheelEventPointDeltaAxis1,
        CGEventField::ScrollWheelEventPointDeltaAxis2,
        CGEventField::ScrollWheelEventPointDeltaAxis3,
        CGEventField::ScrollWheelEventIsContinuous,
    ] {
        CGEvent::set_integer_value_field(
            Some(&event),
            field,
            CGEvent::integer_value_field(Some(&deltas), field),
        );
    }
    Ok(event)
}
