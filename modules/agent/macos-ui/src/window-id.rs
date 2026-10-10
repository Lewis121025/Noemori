//! AX 窗口到 WindowServer 编号的受审计边界；标题和几何不能替代窗口身份。
use objc2_application_services::{AXError, AXUIElement};
use std::{
    ffi::{c_char, c_void},
    sync::OnceLock,
};

type GetWindow = unsafe extern "C" fn(*const AXUIElement, *mut u32) -> AXError;
#[link(name = "System")]
unsafe extern "C" {
    fn dlopen(path: *const c_char, flags: i32) -> *mut c_void;
    fn dlsym(handle: *mut c_void, name: *const c_char) -> *mut c_void;
}

/// 获取保留的 AX 窗口对应的真实编号；接口不可用、系统失败或空编号均拒绝，不猜测同名窗口。
pub(super) fn get(element: &AXUIElement) -> Result<u32, String> {
    static API: OnceLock<Option<GetWindow>> = OnceLock::new();
    let function = API
        .get_or_init(|| {
            // SAFETY: 固定系统框架路径；Darwin 的 RTLD_LAZY=1、RTLD_LOCAL=4。
            // 句柄保留到进程退出，确保缓存函数地址一直有效。
            let handle = unsafe {
                dlopen(
                    c"/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices"
                        .as_ptr(),
                    1 | 4,
                )
            };
            if handle.is_null() {
                return None;
            }
            // SAFETY: 只查固定 SPI 名称；缺失符号不能被调用。
            let symbol = unsafe { dlsym(handle, c"_AXUIElementGetWindow".as_ptr()) };
            if symbol.is_null() {
                return None;
            }
            // SAFETY: SPI 契约是 AXUIElementRef、可写 CGWindowID 地址和 AXError 返回值。
            Some(unsafe { std::mem::transmute::<*mut c_void, GetWindow>(symbol) })
        })
        .ok_or("当前 macOS 不支持精确关联 AX 窗口身份")?;
    let mut number = 0;
    // SAFETY: AX 对象由调用者保留；输出地址在同步调用期间有效。
    let status = unsafe { function(element, &mut number) };
    if status != AXError::Success || number == 0 {
        return Err(format!("不能获取 AX 窗口编号：{}", status.0));
    }
    Ok(number)
}
