//! 会话先撤销派发资格，再结算后端释放和文件清理。
use super::{Pending, UiBroker, wire};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::sync::oneshot;

impl UiBroker {
    /// Drop 路径的尽力释放通知；不关闭用户应用，也不把通知发出当作释放成功。
    /// 需要确认清理结果时使用 release_confirmed；析构阶段不能返回 I/O 错误。
    pub fn release(&self, session: &str) {
        #[cfg(unix)]
        {
            let streams = {
                let mut state = self.inner.state.lock().expect("UI broker 状态锁被污染");
                state.sessions.remove(session);
                state
                    .ports
                    .values()
                    .filter(|port| {
                        port.view.connected
                            && (port.view.backend == "computer"
                                || port.shares.contains_key(session))
                    })
                    .map(|port| port.stream.clone())
                    .collect::<Vec<_>>()
            };
            for stream in streams {
                let _ = wire::write_message(
                    &mut *stream.lock().expect("UI 写入锁被污染"),
                    &json!({"type":"release","session":session}),
                );
            }
        }
        let _ = self.forget_session(session);
    }

    fn forget_session(&self, session: &str) -> Result<(), String> {
        let files = {
            let mut state = self.inner.state.lock().expect("UI broker 状态锁被污染");
            state.sessions.remove(session);
            #[cfg(unix)]
            for port in state.ports.values_mut() {
                port.shares.remove(session);
                port.human.remove(session);
                port.pending.retain(|_, pending| pending.session != session);
            }
            state.receipts.remove(session);
            let ids: Vec<_> = state
                .artifacts
                .iter()
                .filter(|(_, file)| file.session == session)
                .map(|(id, _)| id.clone())
                .collect();
            ids.into_iter()
                .filter_map(|id| state.artifacts.remove(&id))
                .collect::<Vec<_>>()
        };
        // 删除文件也可能阻塞；状态锁只保护资源归属，不覆盖磁盘 I/O。
        let errors: Vec<_> = files
            .into_iter()
            .filter_map(|file| file.path.close().err().map(|error| error.to_string()))
            .collect();
        self.inner.notify();
        if errors.is_empty() {
            Ok(())
        } else {
            Err(format!("UI 下载清理失败：{}", errors.join("；")))
        }
    }

    /// 正常关闭先撤销派发资格，再等待各后端确认释放输入与租约。
    /// 超时、连接中断、未确认释放或文件清理失败时返回诊断，不宣称清理成功。
    pub async fn release_confirmed(&self, session: &str) -> Result<(), String> {
        #[cfg(not(unix))]
        {
            self.forget_session(session)
        }
        #[cfg(unix)]
        {
            let pending = {
                let mut state = self.inner.state.lock().expect("UI broker 状态锁被污染");
                state.sessions.remove(session);
                let mut pending = Vec::new();
                for port in state.ports.values_mut().filter(|port| {
                    port.view.connected
                        && (port.view.backend == "computer" || port.shares.contains_key(session))
                }) {
                    let id = uuid::Uuid::new_v4().to_string();
                    let (sender, receiver) = oneshot::channel();
                    port.pending.insert(
                        id.clone(),
                        Pending {
                            session: session.into(),
                            action: "release".into(),
                            sender: Some(sender),
                        },
                    );
                    pending.push((id, port.stream.clone(), receiver));
                }
                pending
            };
            let mut awaiting = Vec::new();
            let mut errors = Vec::new();
            // 先向所有连接发出释放，再等待确认，避免首个慢后端拖延其他后端停止输入。
            for (id, stream, receiver) in pending {
                match wire::write_message(
                    &mut *stream.lock().expect("UI 写入锁被污染"),
                    &json!({"type":"release","id":id,"session":session}),
                ) {
                    Ok(()) => awaiting.push(receiver),
                    Err(error) => errors.push(error),
                }
            }
            let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
            for receiver in awaiting {
                match tokio::time::timeout_at(deadline, receiver).await {
                    Ok(Ok(Ok(value)))
                        if value.get("outcome").and_then(Value::as_str) == Some("executed") => {}
                    response => errors.push(format!("后端未确认释放控制权：{response:?}")),
                }
            }
            if let Err(error) = self.forget_session(session) {
                errors.push(error);
            }
            if errors.is_empty() {
                Ok(())
            } else {
                Err(errors.join("；"))
            }
        }
    }
}
