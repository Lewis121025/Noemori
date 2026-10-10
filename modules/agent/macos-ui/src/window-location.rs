//! macOS 未公开的窗口局部坐标边界；接口缺失时拒绝输入，不退回系统全局事件。
use objc2_core_foundation::CGPoint;
use objc2_core_graphics::CGEvent;
use std::{
    ffi::{c_char, c_void},
    sync::OnceLock,
};

type SetLocation = unsafe extern "C" fn(*const CGEvent, CGPoint);
type GetLocation = unsafe extern "C" fn(*const CGEvent) -> CGPoint;
struct Api {
    set: SetLocation,
    get: GetLocation,
}
#[link(name = "System")]
unsafe extern "C" {
    fn dlopen(path: *const c_char, flags: i32) -> *mut c_void;
    fn dlsym(handle: *mut c_void, name: *const c_char) -> *mut c_void;
}
fn api() -> Result<&'static Api, String> {
    static API: OnceLock<Option<Api>> = OnceLock::new();
    API.get_or_init(|| {
        // SAFETY: 只加载系统固定路径；RTLD_LAZY=1、RTLD_LOCAL=4 来自 Darwin dlfcn.h。
        // 框架句柄保留到进程退出，防止缓存的函数地址在输入期间失效。
        let handle = unsafe {
            dlopen(
                c"/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics".as_ptr(),
                1 | 4,
            )
        };
        if handle.is_null() {
            return None;
        }
        // SAFETY: 固定名称在已加载的系统框架中查询；缺失指针不能转换或调用。
        let (set, get) = unsafe {
            (
                dlsym(handle, c"CGEventSetWindowLocation".as_ptr()),
                dlsym(handle, c"CGEventGetWindowLocation".as_ptr()),
            )
        };
        if set.is_null() || get.is_null() {
            return None;
        }
        // SAFETY: 两个 SPI 以 CGEventRef 和按值 CGPoint 为契约，已在 macOS 26.6 arm64
        // 验证分数与负坐标的往返；实际接收效果另由独立进程端到端测试核验。
        Some(unsafe {
            Api {
                set: std::mem::transmute::<*mut c_void, SetLocation>(set),
                get: std::mem::transmute::<*mut c_void, GetLocation>(get),
            }
        })
    })
    .as_ref()
    .ok_or_else(|| "当前 macOS 不支持后台窗口坐标输入".into())
}

/// 读取事件独立的窗口局部点；系统接口不可用时返回明确错误。
pub(crate) fn get(event: &CGEvent) -> Result<CGPoint, String> {
    // SAFETY: event 在同步读取期间存活；函数地址经固定系统框架解析并保留。
    Ok(unsafe { (api()?.get)(event) })
}

/// 设置窗口左上角起算的局部点并读回确认；非法点、缺失接口或契约不符均在派发前拒绝。
pub(super) fn set(event: &CGEvent, point: CGPoint) -> Result<(), String> {
    if !point.x.is_finite() || !point.y.is_finite() {
        return Err("窗口局部坐标无效".into());
    }
    // SAFETY: 事件仅由当前调用独占构造；已验证坐标和按值 CGPoint ABI。
    unsafe {
        (api()?.set)(event, point);
    }
    if get(event)? != point {
        return Err("系统未保留目标窗口局部坐标".into());
    }
    Ok(())
}
