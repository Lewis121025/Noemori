//! 已认证连接的消息路由，迟到回执仍更新其原会话。
use super::{Inner, Port, UiConnection, UiRpcError, changes_ui, wire};
use serde_json::{Value, json};
use std::{
    os::unix::net::UnixStream,
    sync::{Arc, Mutex, Weak},
    time::Duration,
};

#[cfg(unix)]
struct Disconnect {
    owner: Weak<Inner>,
    id: String,
}
#[cfg(unix)]
impl Drop for Disconnect {
    fn drop(&mut self) {
        if let Some(inner) = self.owner.upgrade() {
            let mut state = inner.state.lock().expect("UI broker 状态锁被污染");
            state.ui_locks.remove(&self.id);
            let pending = if let Some(port) = state.ports.get_mut(&self.id) {
                port.view.connected = false;
                port.view.human = true;
                std::mem::take(&mut port.pending)
            } else {
                Default::default()
            };
            for (id, pending) in pending {
                let error = "UI 控制连接已断开，动作结果需要核验";
                if let Some(receipt) = state
                    .receipts
                    .get_mut(&pending.session)
                    .and_then(|items| items.iter_mut().find(|r| r.id == id))
                {
                    receipt.pending = false;
                    receipt.outcome = "unknown".into();
                    receipt.error = Some(error.into());
                }
                if let Some(sender) = pending.sender {
                    let _ = sender.send(Err(UiRpcError::Unknown(error.into())));
                }
            }
            drop(state);
            inner.notify();
        }
    }
}
#[cfg(unix)]
pub(super) fn serve(mut stream: UnixStream, weak: Weak<Inner>) -> Result<(), String> {
    // macOS 的 accept 可能继承监听 fd 的非阻塞模式；每连接专用线程必须明确恢复阻塞读。
    stream.set_nonblocking(false).map_err(|e| e.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .map_err(|e| e.to_string())?;
    let hello = wire::read_message(&mut stream)?;
    let inner = weak.upgrade().ok_or("UI broker 已释放")?;
    use subtle::ConstantTimeEq;
    let token = hello.get("token").and_then(Value::as_str).unwrap_or("");
    if hello.get("type").and_then(Value::as_str) != Some("hello")
        || hello.get("version").and_then(Value::as_u64) != Some(1)
        || !bool::from(token.as_bytes().ct_eq(inner.config.token.as_bytes()))
    {
        return Err("UI 连接认证失败".into());
    }
    let backend = hello
        .get("backend")
        .and_then(Value::as_str)
        .filter(|v| matches!(*v, "chrome" | "edge" | "computer"))
        .ok_or("UI 后端类型无效")?
        .to_owned();
    let id = uuid::Uuid::new_v4().to_string();
    let name = hello
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or(&backend)
        .chars()
        .take(100)
        .collect();
    let writer = Arc::new(Mutex::new(stream.try_clone().map_err(|e| e.to_string())?));
    let sessions = {
        let mut state = inner.state.lock().expect("UI broker 状态锁被污染");
        let sessions = state.sessions.clone();
        state.ports.insert(
            id.clone(),
            Port {
                stream: writer.clone(),
                view: UiConnection {
                    id: id.clone(),
                    backend,
                    name,
                    connected: true,
                    tabs: vec![],
                    human: false,
                },
                shares: Default::default(),
                human: Default::default(),
                pending: Default::default(),
            },
        );
        sessions
    };
    let _disconnect = Disconnect {
        owner: weak.clone(),
        id: id.clone(),
    };
    wire::write_message(
        &mut *writer.lock().expect("UI 写入锁被污染"),
        &json!({"type":"welcome","connection":id,"sessions":sessions}),
    )?;
    inner.notify();
    drop(inner);
    stream.set_read_timeout(None).map_err(|e| e.to_string())?;

    loop {
        let frame = match wire::read_message(&mut stream) {
            Ok(frame) => frame,
            Err(error) => break Err(error),
        };
        let Some(inner) = weak.upgrade() else {
            break Ok(());
        };
        if frame.get("type").and_then(Value::as_str) == Some("artifact") {
            let saved = super::artifacts::save(&inner, &id, &frame);
            let response = match saved {
                Ok((artifact, bytes)) => {
                    json!({"type":"artifact_saved","id":artifact,"bytes":bytes,"error":null})
                }
                Err(error) => json!({"type":"artifact_saved","id":frame.get("id"),"error":error}),
            };
            wire::write_message(&mut *writer.lock().expect("UI 写入锁被污染"), &response)?;
            inner.notify();
            continue;
        }
        match frame.get("type").and_then(Value::as_str) {
            Some("result") => settle(&inner, &id, &frame),
            Some("sessions") => {
                let sessions = inner
                    .state
                    .lock()
                    .expect("UI broker 状态锁被污染")
                    .sessions
                    .clone();
                wire::write_message(
                    &mut *writer.lock().expect("UI 写入锁被污染"),
                    &json!({"type":"sessions","sessions":sessions}),
                )?;
            }
            Some("share") => share_tabs(&inner, &id, &frame)?,
            Some("event") => human_event(&inner, &id, &frame),
            Some("ui_lock") => set_ui_lock(
                &inner,
                &id,
                frame.get("active").and_then(Value::as_bool) == Some(true),
            )?,
            _ => return Err("UI 后端发送了未知消息".into()),
        }
        inner.notify();
    }
}

fn settle(inner: &Inner, id: &str, frame: &Value) {
    let mut effect = None;
    let mut reply = None;
    let mut state = inner.state.lock().expect("UI broker 状态锁被污染");

    let operation = frame.get("id").and_then(Value::as_str).unwrap_or("");
    if let Some(pending) = state
        .ports
        .get_mut(id)
        .and_then(|p| p.pending.remove(operation))
    {
        let mut value = frame.get("value").cloned().unwrap_or(Value::Null);
        if serde_json::from_value::<crate::tool::browser::BrowserOutcome>(
            value.get("outcome").cloned().unwrap_or(Value::Null),
        )
        .is_err()
        {
            value = json!({"outcome":"unknown","error":"UI 后端回执阶段无效，动作结果需要核验"});
        }
        if let Some(receipt) = state
            .receipts
            .get_mut(&pending.session)
            .and_then(|items| items.iter_mut().find(|receipt| receipt.id == operation))
        {
            receipt.pending = false;
            receipt.outcome = value
                .get("outcome")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .into();
            receipt.error = value
                .get("error")
                .and_then(Value::as_str)
                .map(|v| v.chars().take(2000).collect());
        }
        if let Some(port) = state.ports.get_mut(id) {
            if value.get("mode").and_then(Value::as_str) == Some("human") {
                port.human.insert(pending.session.clone());
            } else if matches!(pending.action.as_str(), "resume" | "grant_control")
                && value.get("outcome").and_then(Value::as_str) == Some("executed")
            {
                port.human.remove(&pending.session);
            }
        }
        if matches!(
            value.get("outcome").and_then(Value::as_str),
            Some("executed" | "unknown")
        ) && changes_ui(&pending.action)
        {
            effect = Some((
                state
                    .ports
                    .get(id)
                    .map(|port| port.view.backend.clone())
                    .unwrap_or_default(),
                value
                    .get("bundle_id")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            ));
        }
        if let Some(sender) = pending.sender {
            reply = Some((sender, value));
        }
    }

    drop(state);
    if let Some((backend, bundle)) = effect {
        inner.invalidate_related(&backend, bundle.as_deref());
    }
    if let Some((sender, value)) = reply {
        let _ = sender.send(Ok(value));
    }
}

fn share_tabs(inner: &Inner, id: &str, frame: &Value) -> Result<(), String> {
    let mut state = inner.state.lock().expect("UI broker 状态锁被污染");

    let session = frame
        .get("session")
        .and_then(Value::as_str)
        .ok_or("共享缺少会话身份")?;
    if !state.sessions.contains_key(session) {
        return Err("共享会话不存在".into());
    }
    let tabs = frame
        .get("tabs")
        .and_then(Value::as_array)
        .filter(|t| t.len() <= 32)
        .ok_or("共享标签页超限")?
        .clone();
    for other in state.ports.values() {
        if other.shares.iter().any(|(owner, leased)| {
            owner != session
                && leased
                    .iter()
                    .any(|t| tabs.iter().any(|v| v.get("id") == t.get("id")))
        }) {
            return Err("标签页已被其他会话占用".into());
        }
    }
    let port = state.ports.get_mut(id).ok_or("连接不存在")?;
    port.shares.insert(session.into(), tabs);

    Ok(())
}

fn human_event(inner: &Inner, id: &str, frame: &Value) {
    let backend = {
        let mut state = inner.state.lock().expect("UI broker 状态锁被污染");
        if frame.get("event").and_then(Value::as_str) != Some("human") {
            return;
        }
        let Some(session) = frame.get("session").and_then(Value::as_str) else {
            return;
        };
        let Some(port) = state.ports.get_mut(id) else {
            return;
        };
        port.human.insert(session.into());
        port.view.backend.clone()
    };
    inner.invalidate_related(&backend, None);
}

fn set_ui_lock(inner: &Inner, id: &str, active: bool) -> Result<(), String> {
    let streams = {
        let mut state = inner.state.lock().expect("UI broker 状态锁被污染");
        if !active {
            state.ui_locks.remove(id);
            return Ok(());
        }
        state.ui_locks.insert(id.into());
        let sessions: Vec<_> = state.sessions.keys().cloned().collect();
        state
            .ports
            .values_mut()
            .filter(|port| port.view.backend == "computer" && port.view.connected)
            .map(|port| {
                port.human.extend(sessions.iter().cloned());
                port.stream.clone()
            })
            .collect::<Vec<_>>()
    };
    for stream in streams {
        wire::write_message(
            &mut *stream.lock().expect("UI 写入锁被污染"),
            &json!({"type":"pause","session":"*"}),
        )?;
    }
    Ok(())
}
