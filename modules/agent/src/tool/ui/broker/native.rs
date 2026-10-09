//! 可信进程启动与浏览器 Native Messaging 接入。
use super::{ConnectionConfig, UiBroker, wire};
use crate::ExecutionContext;
use serde_json::{Value, json};
#[cfg(unix)]
use std::os::unix::{fs::PermissionsExt, net::UnixStream};
use std::{fs, time::Duration};

impl UiBroker {
    /// 通过 LaunchServices 启动稳定 helper 应用；等待认证连接期间遵守调用的取消和预算。
    /// 已有连接时直接复用；非 macOS、启动失败或认证连接超时返回错误。
    pub async fn ensure_computer(
        &self,
        helper: &std::path::Path,
        context: &ExecutionContext,
    ) -> Result<(), String> {
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (helper, context);
            Err("Computer Use 需要 macOS".into())
        }
        #[cfg(target_os = "macos")]
        {
            let _guard = context
                .wait(self.inner.launch.lock())
                .await
                .map_err(|e| e.to_string())?;
            let connected = || {
                self.inner
                    .state
                    .lock()
                    .expect("UI broker 状态锁被污染")
                    .ports
                    .values()
                    .any(|port| port.view.backend == "computer" && port.view.connected)
            };
            if connected() {
                return Ok(());
            }
            let mut command = tokio::process::Command::new("/usr/bin/open");
            command
                .arg("-g")
                .arg("-n")
                .arg("-a")
                .arg(helper)
                .arg("--args")
                .arg("--connection")
                .arg(self.configuration_path())
                .arg("--protected")
                .arg(std::process::id().to_string());
            let status = context
                .wait(command.status())
                .await
                .map_err(|e| e.to_string())?
                .map_err(|e| e.to_string())?;
            if !status.success() {
                return Err("LaunchServices 拒绝启动原生 helper".into());
            }
            context
                .wait(async {
                    let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
                    while !connected() {
                        if tokio::time::Instant::now() >= deadline {
                            return Err("原生 helper 没有建立认证连接".into());
                        }
                        tokio::time::sleep(Duration::from_millis(30)).await;
                    }
                    Ok(())
                })
                .await
                .map_err(|e| e.to_string())?
        }
    }
}

/// Native Messaging 入口；校验浏览器传入的固定扩展来源，并只转发私有本地连接。
/// 来源、定位文件权限、协议或 I/O 失败时退出，标准输出只写协议帧。
pub fn run_native_bridge() -> Result<(), String> {
    #[cfg(not(unix))]
    {
        Err("Native Messaging 暂不支持此平台".into())
    }
    #[cfg(unix)]
    {
        let executable = std::env::current_exe().map_err(|e| e.to_string())?;
        let path = executable
            .parent()
            .ok_or("桥接入口路径无效")?
            .join("connection.json");
        let metadata = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if !metadata.is_file() || metadata.permissions().mode() & 0o077 != 0 {
            return Err("Native Messaging 定位文件权限无效".into());
        }
        let config: ConnectionConfig =
            serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        if std::env::args().nth(1).as_deref()
            != Some(format!("chrome-extension://{}/", config.extension_id).as_str())
        {
            return Err("Native Messaging 扩展来源不符".into());
        }
        let mut input = std::io::stdin().lock();
        let mut hello = wire::read_message(&mut input)?;
        if hello.get("type").and_then(Value::as_str) != Some("hello")
            || hello.get("version").and_then(Value::as_u64) != Some(1)
        {
            return Err("Native Messaging 协议版本或握手类型无效".into());
        }
        if !matches!(
            hello.get("backend").and_then(Value::as_str),
            Some("chrome" | "edge")
        ) {
            return Err("扩展后端类型无效".into());
        }
        hello["token"] = json!(config.token);
        hello["version"] = json!(1);
        hello["type"] = json!("hello");
        let mut stream = UnixStream::connect(config.socket).map_err(|e| e.to_string())?;
        wire::write_message(&mut stream, &hello)?;
        let mut replies = stream.try_clone().map_err(|e| e.to_string())?;
        std::thread::spawn(move || {
            let mut stdout = std::io::stdout().lock();
            while let Ok(frame) = wire::read_message(&mut replies) {
                if wire::write_message(&mut stdout, &frame).is_err() {
                    break;
                }
            }
        });
        while let Ok(frame) = wire::read_message(&mut input) {
            wire::write_message(&mut stream, &frame)?;
        }
        stream
            .shutdown(std::net::Shutdown::Both)
            .map_err(|e| e.to_string())
    }
}
