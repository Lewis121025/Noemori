//! 独立原生应用入口；OS 权限属于稳定的 helper 应用身份。
#[cfg(target_os = "macos")]
fn main() {
    if let Err(error) = run() {
        eprintln!("原生服务退出：{error}");
        std::process::exit(1);
    }
}
#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("Computer Use 需要 macOS 14 或更新版本");
    std::process::exit(1);
}

#[cfg(target_os = "macos")]
fn run() -> Result<(), String> {
    use noemori_agent::tool::ui::{broker::ConnectionConfig, wire};
    use serde_json::{Value, json};
    use std::{
        collections::BTreeMap,
        os::unix::{fs::PermissionsExt, net::UnixStream},
        sync::{
            Arc, Mutex,
            atomic::{AtomicBool, Ordering},
            mpsc,
        },
        time::Duration,
    };
    let args = std::env::args().collect::<Vec<_>>();
    let config_path = args
        .windows(2)
        .find(|pair| pair[0] == "--connection")
        .map(|pair| &pair[1])
        .ok_or("原生服务只能由宿主启动")?;
    let metadata = std::fs::symlink_metadata(config_path).map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.permissions().mode() & 0o077 != 0 {
        return Err("原生服务定位文件权限无效".into());
    }
    let config: ConnectionConfig =
        serde_json::from_slice(&std::fs::read(config_path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let mut protected = vec![std::process::id() as i32];
    if let Some(pid) = args
        .windows(2)
        .find(|pair| pair[0] == "--protected")
        .and_then(|pair| pair[1].parse::<i32>().ok())
    {
        protected.push(pid);
    }
    let mut service = noemori_macos_ui::Service::new(protected)?;
    let mut stream = UnixStream::connect(config.socket).map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .map_err(|e| e.to_string())?;
    wire::write_message(
        &mut stream,
        &json!({"type":"hello","version":1,"token":config.token,"backend":"computer","name":"Noemori Computer Helper"}),
    )?;
    if wire::read_message(&mut stream)?["type"] != "welcome" {
        return Err("原生服务未获得宿主连接".into());
    }
    let mut reader = stream.try_clone().map_err(|e| e.to_string())?;
    type CancellationMap = Arc<Mutex<BTreeMap<String, (String, Arc<AtomicBool>)>>>;
    let cancelled: CancellationMap = Default::default();
    let flags = cancelled.clone();
    let (sender, receiver) = mpsc::sync_channel(32);
    std::thread::spawn(move || {
        while let Ok(frame) = wire::read_message(&mut reader) {
            match frame["type"].as_str() {
                Some("call") => {
                    let (Some(id), Some(session)) =
                        (frame["id"].as_str(), frame["session"].as_str())
                    else {
                        break;
                    };
                    let mut active = flags.lock().expect("原生取消锁被污染");
                    if active.len() >= 32 || active.contains_key(id) {
                        break;
                    }
                    active.insert(
                        id.into(),
                        (session.into(), Arc::new(AtomicBool::new(false))),
                    );
                }
                Some("cancel") => {
                    if let Some((_, flag)) = frame["id"]
                        .as_str()
                        .and_then(|id| flags.lock().expect("原生取消锁被污染").get(id).cloned())
                    {
                        flag.store(true, Ordering::Release);
                    }
                    continue;
                }
                Some("release" | "pause") => {
                    let session = frame["session"].as_str();
                    for (owner, flag) in flags.lock().expect("原生取消锁被污染").values() {
                        if session == Some("*") || session == Some(owner.as_str()) {
                            flag.store(true, Ordering::Release);
                        }
                    }
                }
                _ => {}
            }
            if sender.send(frame).is_err() {
                break;
            }
        }
        for (_, flag) in flags.lock().expect("原生取消锁被污染").values() {
            flag.store(true, Ordering::Release);
        }
    });
    let result = loop {
        let ended = objc2::rc::autoreleasepool(|_| -> Result<bool, String> {
            for session in service.poll() {
                wire::write_message(
                    &mut stream,
                    &json!({"type":"event","event":"human","session":session}),
                )?;
            }
            match receiver.recv_timeout(Duration::from_millis(10)) {
                Ok(frame) => {
                    let session = frame["session"].as_str().ok_or("原生消息缺少会话")?;
                    match frame["type"].as_str() {
                        Some("invalidate") => service.invalidate(frame["scope"] == "browsers"),
                        Some("release" | "pause") => {
                            service.release(session);
                            if let Some(id) = frame.get("id") {
                                wire::write_message(
                                    &mut stream,
                                    &json!({"type":"result","id":id,"value":{"outcome":"executed","mode":"human"}}),
                                )?;
                            }
                        }
                        Some("call") => {
                            let id = frame["id"].as_str().ok_or("原生动作缺少标识")?;
                            let flag = cancelled
                                .lock()
                                .expect("原生取消锁被污染")
                                .get(id)
                                .map(|(_, flag)| flag.clone())
                                .ok_or("原生动作缺少取消归属")?;
                            let now = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .map_err(|e| e.to_string())?
                                .as_millis();
                            let remaining = frame["expires_at"]
                                .as_u64()
                                .map(|deadline| u128::from(deadline).saturating_sub(now))
                                .unwrap_or(0)
                                .min(u128::from(frame["timeout_ms"].as_u64().unwrap_or(0)))
                                .min(120000) as u64;
                            let (complete, wait) = mpsc::channel::<()>();
                            let deadline_flag = flag.clone();
                            std::thread::spawn(move || {
                                if wait.recv_timeout(Duration::from_millis(remaining)).is_err() {
                                    deadline_flag.store(true, Ordering::Release);
                                }
                            });
                            let value = if remaining == 0 {
                                json!({"outcome":"not_executed","error":"原生动作到达时预算已耗尽"})
                            } else {
                                service.execute(
                                    session,
                                    frame.get("action").cloned().unwrap_or(Value::Null),
                                    flag,
                                )
                            };
                            let _ = complete.send(());
                            cancelled.lock().expect("原生取消锁被污染").remove(id);
                            wire::write_message(
                                &mut stream,
                                &json!({"type":"result","id":id,"value":value}),
                            )?;
                        }
                        _ => return Err("原生消息类型无效".into()),
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    service.release("*");
                    return Ok(true);
                }
            }
            Ok(false)
        });
        match ended {
            Ok(false) => {}
            Ok(true) => break Ok(()),
            Err(error) => break Err(error),
        }
    };
    service.release("*");
    // 断连后不再接收或派发输入；已投递的 V 尚未消费时必须继续保留原剪贴板材料。
    while objc2::rc::autoreleasepool(|_| service.poll_clipboard()) {
        std::thread::sleep(Duration::from_millis(20));
    }
    result
}
