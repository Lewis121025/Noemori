//! 输入直接投递给已验证的目标进程，不进入系统全局事件队列或移动用户光标。
use objc2_core_foundation::{CFRetained, CFRunLoop, CGPoint, kCFRunLoopDefaultMode};
use objc2_core_graphics::*;
use std::time::Duration;

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
/// 键盘与滚动按进程投递；应用内部的输入窗口由 Service 每次发送前核验。
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
}
impl WindowTarget {
    /// 目标必须同时具有有效进程和非零截图窗口编号。
    pub(crate) fn new(pid: i32, window: u32) -> Result<Self, String> {
        if window == 0 {
            return Err("后台输入窗口无效".into());
        }
        Ok(Self {
            process: ProcessTarget::new(pid)?,
            window,
        })
    }
    /// 只供本模块生成的鼠标事件绑定窗口，不用于键盘或滚轮事件。
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
fn mouse(
    target: WindowTarget,
    source: &CGEventSource,
    kind: CGEventType,
    point: CGPoint,
    button: CGMouseButton,
    clicks: i64,
    dispatched: &mut bool,
) -> Result<(), String> {
    let event =
        CGEvent::new_mouse_event(Some(source), kind, point, button).ok_or("不能创建鼠标事件")?;
    CGEvent::set_integer_value_field(Some(&event), CGEventField::MouseEventClickState, clicks);
    target.route(&event);
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
    if !(1..=3).contains(&clicks) {
        return Err("点击次数无效".into());
    }
    let source = source()?;
    for index in 1..=clicks {
        check()?;
        mouse(
            target,
            &source,
            down,
            point,
            button,
            index.into(),
            dispatched,
        )?;
        let released = mouse(target, &source, up, point, button, index.into(), dispatched);
        released?;
        check()?;
    }
    Ok(())
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
/// 只在已核验后台窗口点滚动；非有限或过量滚动拒绝，派发事实通过 dispatched 返回。
pub(crate) fn scroll(
    target: ProcessTarget,
    point: CGPoint,
    x: f64,
    y: f64,
    check: impl Fn() -> Result<(), String>,
    dispatched: &mut bool,
) -> Result<(), String> {
    if !x.is_finite() || !y.is_finite() || x.abs() > 100000.0 || y.abs() > 100000.0 {
        return Err("滚动量无效".into());
    }
    check()?;
    let source = source()?;
    let event = CGEvent::new_scroll_wheel_event2(
        Some(&source),
        CGScrollEventUnit::Pixel,
        2,
        y.round() as i32,
        x.round() as i32,
        0,
    )
    .ok_or("不能创建滚动事件")?;
    CGEvent::set_location(Some(&event), point);
    post(target, &event, dispatched);
    check()
}
