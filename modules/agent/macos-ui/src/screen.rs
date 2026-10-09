//! ScreenCaptureKit 的异步回调只交付 Rust 字节和坐标，不将系统对象送到其他线程。
use super::ax::Bounds;
use block2::RcBlock;
use objc2::AnyThread;
use objc2_core_foundation::{CFMutableData, CFString};
use objc2_core_graphics::{CGImage, CGPreflightScreenCaptureAccess};
use objc2_foundation::NSError;
use objc2_image_io::CGImageDestination;
use objc2_screen_capture_kit::{
    SCContentFilter, SCScreenshotManager, SCShareableContent, SCStreamConfiguration,
};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

static PENDING: AtomicUsize = AtomicUsize::new(0);
struct CaptureLifetime {
    cancelled: AtomicBool,
}
impl Drop for CaptureLifetime {
    fn drop(&mut self) {
        PENDING.fetch_sub(1, Ordering::AcqRel);
    }
}
struct CancelOnReturn(Arc<CaptureLifetime>);
impl Drop for CancelOnReturn {
    fn drop(&mut self) {
        self.0.cancelled.store(true, Ordering::Release);
    }
}
/// 回调只交付实际编码字节、图像尺寸和源窗口范围，避免推断 Retina 或裁剪坐标。
pub(crate) struct Captured {
    pub bytes: Vec<u8>,
    pub width: usize,
    pub height: usize,
    pub window_id: u32,
    pub bounds: Bounds,
}

/// 只读取屏幕录制授权，不通过模型触发系统授权。
pub(crate) fn permitted() -> bool {
    CGPreflightScreenCaptureAccess()
}
fn encode(image: &CGImage) -> Result<Vec<u8>, String> {
    let data = CFMutableData::new(None, 0).ok_or("不能创建截图输出")?;
    // SAFETY: 有效的可变数据、JPEG 类型和单帧数量，没有未检查的字典泛型。
    let destination = unsafe {
        CGImageDestination::with_data(&data, &CFString::from_static_str("public.jpeg"), 1, None)
    }
    .ok_or("不能创建 JPEG 编码器")?;
    // SAFETY: image 由截图回调借用，编码在回调返回前完成；没有外部属性指针。
    unsafe {
        destination.add_image(image, None);
        if !destination.finalize() {
            return Err("截图编码失败".into());
        }
    }
    let bytes = data.to_vec();
    if bytes.len() > 5 * 1024 * 1024 {
        return Err("截图超过 5 MiB".into());
    }
    Ok(bytes)
}
fn error(pointer: *mut NSError) -> String {
    // SAFETY: 非空 NSError 由 Apple 在当前回调生命周期内提供借用。
    unsafe { pointer.as_ref() }
        .map(|error| error.localizedDescription().to_string())
        .unwrap_or_else(|| "截图服务没有返回图像".into())
}

/// 根据 PID、标题和范围唯一关联窗口；返回实际图像尺寸与源范围，失败、取消或超时返回诊断。
pub(crate) fn capture(
    pid: i32,
    title: String,
    bounds: Bounds,
    cancel: impl Fn() -> bool,
) -> Result<Captured, String> {
    if !permitted() {
        return Err("请在系统设置授予 Noemori Computer Helper 屏幕录制权限".into());
    }
    PENDING
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |pending| {
            if pending < 4 { Some(pending + 1) } else { None }
        })
        .map_err(|_| "系统尚有未结算截图回调，拒绝累积更多请求")?;
    let pending = Arc::new(CaptureLifetime {
        cancelled: AtomicBool::new(false),
    });
    let _cancel = CancelOnReturn(pending.clone());
    let (sender, receiver) = mpsc::sync_channel(1);
    let block = RcBlock::new(
        move |content: *mut SCShareableContent, failure: *mut NSError| {
            if pending.cancelled.load(Ordering::Acquire) {
                return;
            }
            // SAFETY: content 指针只在 Apple 回调期间借用；子窗口随后被 filter 保留。
            let Some(content) = (unsafe { content.as_ref() }) else {
                let _ = sender.send(Err(error(failure)));
                return;
            };
            // SAFETY: shareable content 在回调期间有效，返回窗口数组具有正常 Objective-C 所有权。
            let windows = unsafe { content.windows() };
            let candidates: Vec<_> = windows
                .iter()
                .filter(|window| {
                    // SAFETY: 窗口来自当前保留数组；所有 getter 只读取其有效元数据。
                    unsafe {
                        window
                            .owningApplication()
                            .is_some_and(|app| app.processID() == pid)
                            && window.title().map(|v| v.to_string()).unwrap_or_default() == title
                            && {
                                let frame = window.frame();
                                (frame.origin.x - bounds.x).abs() < 2.0
                                    && (frame.origin.y - bounds.y).abs() < 2.0
                                    && (frame.size.width - bounds.width).abs() < 2.0
                                    && (frame.size.height - bounds.height).abs() < 2.0
                            }
                    }
                })
                .collect();
            if candidates.len() != 1 {
                let _ = sender.send(Err(
                    "无法唯一关联 AX 与截图窗口，请重新观察；不会猜测其他窗口".into(),
                ));
                return;
            }
            // SAFETY: 选中的窗口具有唯一进程、标题和范围匹配；filter 保留该窗口。
            let (filter, config, number) = unsafe {
                (
                    SCContentFilter::initWithDesktopIndependentWindow(
                        SCContentFilter::alloc(),
                        &candidates[0],
                    ),
                    SCStreamConfiguration::new(),
                    candidates[0].windowID(),
                )
            };
            // SAFETY: filter 与唯一窗口均在当前回调保留；只读取真实像素比例和范围。
            let (pixel_scale, frame) = unsafe { (filter.pointPixelScale(), candidates[0].frame()) };
            let capture_bounds = Bounds {
                x: frame.origin.x,
                y: frame.origin.y,
                width: frame.size.width,
                height: frame.size.height,
            };
            if !pixel_scale.is_finite()
                || pixel_scale <= 0.0
                || capture_bounds.width <= 0.0
                || capture_bounds.height <= 0.0
            {
                let _ = sender.send(Err("系统返回无效截图比例或空窗口".into()));
                return;
            }
            let scale = (2400.0 / capture_bounds.width.max(capture_bounds.height))
                .min(f64::from(pixel_scale));
            let width = (capture_bounds.width * scale).round().max(1.0) as usize;
            let height = (capture_bounds.height * scale).round().max(1.0) as usize;
            // SAFETY: 配置在提交前由本回调独占；尺寸经过有限正数校验。
            unsafe {
                config.setWidth(width);
                config.setHeight(height);
                config.setShowsCursor(false);
                config.setIgnoreShadowsSingleWindow(true);
            }
            let sender = sender.clone();
            let keep_filter = filter.clone();
            let keep_config = config.clone();
            let pending = pending.clone();
            let image_block = RcBlock::new(move |image: *mut CGImage, failure: *mut NSError| {
                let _keep = (&keep_filter, &keep_config);
                if pending.cancelled.load(Ordering::Acquire) {
                    return;
                }
                // SAFETY: CGImage 在当前 Apple 回调期间有效，编码不保留借用到回调外。
                let result = unsafe { image.as_ref() }
                    .ok_or_else(|| error(failure))
                    .and_then(|image| {
                        encode(image).map(|bytes| Captured {
                            bytes,
                            width: CGImage::width(Some(image)),
                            height: CGImage::height(Some(image)),
                            window_id: number,
                            bounds: capture_bounds,
                        })
                    });
                let _ = sender.send(result);
            });
            // SAFETY: 所有对象和完成 block 都有效；完成 block 持有配置直到异步回调结束。
            unsafe {
                SCScreenshotManager::captureImageWithFilter_configuration_completionHandler(
                    &filter,
                    &config,
                    Some(&image_block),
                );
            }
        },
    );
    // SAFETY: 完成 block 被框架复制并在回调期间保持有效，没有 Rust 栈借用。
    unsafe {
        SCShareableContent::getShareableContentExcludingDesktopWindows_onScreenWindowsOnly_completionHandler(true,false,&block);
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if cancel() {
            return Err("截图已取消".into());
        }
        match receiver.recv_timeout(Duration::from_millis(10)) {
            Ok(result) => return result,
            Err(mpsc::RecvTimeoutError::Disconnected) => return Err("截图回调断开".into()),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        if Instant::now() >= deadline {
            return Err("截图超过五秒预算".into());
        }
        super::input::pump();
    }
}
