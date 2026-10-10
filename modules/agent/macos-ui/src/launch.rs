//! 应用只由 LaunchServices 的安装索引解析；后台启动不接受路径、参数或激活请求。
use block2::RcBlock;
use objc2_app_kit::{NSRunningApplication, NSWorkspace, NSWorkspaceOpenConfiguration};
use objc2_foundation::{NSBundle, NSError, NSString};
use serde_json::{Value, json};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

fn installed(
    bundle_id: &str,
) -> Result<(objc2::rc::Retained<objc2_foundation::NSURL>, String), String> {
    if bundle_id.is_empty()
        || bundle_id.len() > 256
        || !bundle_id
            .bytes()
            .all(|value| value.is_ascii_alphanumeric() || matches!(value, b'.' | b'-' | b'_'))
    {
        return Err("启动应用必须使用已安装的 bundle identifier".into());
    }
    let url = NSWorkspace::sharedWorkspace()
        .URLForApplicationWithBundleIdentifier(&NSString::from_str(bundle_id))
        .ok_or("系统安装索引没有该应用")?;
    let bundle = NSBundle::bundleWithURL(&url).ok_or("系统返回的应用 bundle 无法读取")?;
    if bundle
        .bundleIdentifier()
        .as_deref()
        .map(NSString::to_string)
        .as_deref()
        != Some(bundle_id)
    {
        return Err("系统应用标识不一致，未启动应用".into());
    }
    let name = ["CFBundleDisplayName", "CFBundleName"]
        .into_iter()
        .find_map(|key| {
            bundle
                .objectForInfoDictionaryKey(&NSString::from_str(key))
                .and_then(|value| value.downcast_ref::<NSString>().map(NSString::to_string))
                .filter(|value| !value.trim().is_empty())
        })
        .ok_or("应用缺少可信名称，不能请求启动授权")?;
    Ok((url, name))
}

/// 读取实际安装应用的身份与名称供宿主审批；无效标识或安装材料不一致返回错误。
pub(crate) fn info(bundle_id: &str) -> Result<Value, String> {
    let (_, app_name) = installed(bundle_id)?;
    Ok(json!({"outcome":"observed","bundle_id":bundle_id,"app_name":app_name}))
}

/// 只接收已批准的一次启动；取消或回调错误返回真实阶段，前台改变不能伪装为后台成功。
pub(crate) fn launch(
    bundle_id: &str,
    cancel: &AtomicBool,
    dispatched: &mut bool,
) -> Result<Value, String> {
    let (url, app_name) = installed(bundle_id)?;
    if cancel.load(Ordering::Acquire) {
        return Err("应用启动已取消".into());
    }
    let workspace = NSWorkspace::sharedWorkspace();
    let before = workspace
        .frontmostApplication()
        .map(|app| app.processIdentifier());
    let config = NSWorkspaceOpenConfiguration::configuration();
    config.setActivates(false);
    config.setAddsToRecentItems(false);
    config.setCreatesNewApplicationInstance(false);
    config.setAllowsRunningApplicationSubstitution(false);
    let (sender, receiver) = mpsc::sync_channel(1);
    let callback = RcBlock::new(move |app: *mut NSRunningApplication, error: *mut NSError| {
        // SAFETY: 两个指针只在 Apple completion handler 期间借用，仅提取拥有的诊断及 PID。
        let result = unsafe {
            if let Some(error) = error.as_ref() {
                Err(error.localizedDescription().to_string())
            } else {
                app.as_ref()
                    .map(|app| app.processIdentifier())
                    .filter(|pid| *pid > 0)
                    .ok_or_else(|| "系统启动回调没有有效应用身份".to_owned())
            }
        };
        let _ = sender.send(result);
    });
    *dispatched = true;
    workspace.openApplicationAtURL_configuration_completionHandler(&url, &config, Some(&callback));
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if cancel.load(Ordering::Acquire) {
            return Err("应用启动已派发后取消，结果未知，禁止重放".into());
        }
        match receiver.try_recv() {
            Ok(result) => {
                let pid = result?;
                if workspace
                    .frontmostApplication()
                    .map(|app| app.processIdentifier())
                    != before
                {
                    return Err("应用启动改变了前台焦点，无法确认后台启动".into());
                }
                let app = NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
                    .ok_or("已启动应用不再存活")?;
                if app
                    .bundleIdentifier()
                    .as_deref()
                    .map(NSString::to_string)
                    .as_deref()
                    != Some(bundle_id)
                {
                    return Err("已启动应用身份与批准目标不符".into());
                }
                let launch = app
                    .launchDate()
                    .map(|date| date.timeIntervalSince1970())
                    .ok_or("已启动应用缺少启动实例身份")?;
                return Ok(
                    json!({"outcome":"executed","bundle_id":bundle_id,"app_name":app_name,"app":format!("{pid}:{launch:.6}"),"background":true}),
                );
            }
            Err(mpsc::TryRecvError::Disconnected) => {
                return Err("应用启动回调断开，结果未知".into());
            }
            Err(mpsc::TryRecvError::Empty) => {}
        }
        if Instant::now() >= deadline {
            return Err("应用启动回调未在预算内结算，结果未知，禁止重放".into());
        }
        super::input::pump();
        std::thread::sleep(Duration::from_millis(10));
    }
}
