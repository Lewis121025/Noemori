//! 每个运行时只保留一个待发布请求；同版本搜索仍由 Vault 的事务屏障保证。

use crate::VaultEvent;
use noemori_vault::{SearchCancellation, Vault};
use std::sync::Arc;
use std::time::Duration;
use tokio::{sync::watch, task::JoinHandle};

#[derive(Clone)]
struct Request {
    vault: Arc<Vault>,
    generation: u64,
    cancellation: SearchCancellation,
}

#[derive(Clone)]
pub(crate) struct Publisher(watch::Sender<Option<Request>>);

impl Publisher {
    pub(crate) fn start(notify: Arc<dyn Fn(VaultEvent) + Send + Sync>) -> (Self, JoinHandle<()>) {
        let (sender, mut receiver) = watch::channel::<Option<Request>>(None);
        let task = tokio::spawn(async move {
            while receiver.changed().await.is_ok() {
                // 连续保存期间只积累最新请求，避免每次发布持有数据库锁阻塞下一次写入。
                // 查询仍有自己的同步屏障，不依赖这段静默期来保证可见性。
                loop {
                    match tokio::time::timeout(Duration::from_millis(200), receiver.changed()).await
                    {
                        Ok(Ok(())) => {}
                        Ok(Err(_)) => return,
                        Err(_) => break,
                    }
                }
                let request = receiver.borrow_and_update().clone();
                let Some(request) = request else {
                    continue;
                };
                let cancellation = request.cancellation.clone();
                let generation = request.generation;
                let result = tokio::task::spawn_blocking(move || {
                    request.vault.publish_search_index(&request.cancellation)?;
                    request.vault.publish_semantic_index(&request.cancellation)
                })
                .await;
                if cancellation.is_cancelled() {
                    continue;
                }
                let message = match result {
                    Ok(Ok(())) => continue,
                    Ok(Err(error)) => error.to_string(),
                    Err(error) => format!("搜索索引发布任务异常：{error}"),
                };
                notify(VaultEvent {
                    generation,
                    status: "index-error".into(),
                    paths: Vec::new(),
                    healthy: false,
                    message: Some(message),
                });
            }
        });
        (Self(sender), task)
    }

    pub(crate) fn schedule(
        &self,
        vault: Arc<Vault>,
        generation: u64,
        cancellation: SearchCancellation,
    ) {
        self.0.send_replace(Some(Request {
            vault,
            generation,
            cancellation,
        }));
    }

    pub(crate) fn clear(&self) {
        self.0.send_replace(None);
    }
}
