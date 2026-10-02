//! 候选监听器先安装后核对，归属提交后才发布通知；回收不等待宿主回调。

use crate::{Result, VaultEvent};
use noemori_vault::{Vault, WatchHandle};
use std::{
    path::Path,
    sync::{
        atomic::{AtomicU8, Ordering},
        Arc,
    },
    time::Duration,
};

pub(crate) struct WatchedVault {
    pub(crate) vault: Arc<Vault>,
    watch: Option<WatchHandle>,
    status: Arc<AtomicU8>,
    generation: u64,
    cancellation: noemori_vault::SearchCancellation,
}

impl WatchedVault {
    pub(crate) fn new(
        vault: Arc<Vault>,
        generation: u64,
        notify: Arc<dyn Fn(VaultEvent) + Send + Sync>,
        publisher: crate::publication::Publisher,
    ) -> Result<Self> {
        let root = std::fs::canonicalize(vault.root())?;
        let watched = Arc::clone(&vault);
        let status = Arc::new(AtomicU8::new(0));
        let active = Arc::clone(&status);
        let cancellation = noemori_vault::SearchCancellation::default();
        let token = cancellation.clone();
        let watch =
            noemori_vault::start_watch(root.clone(), Duration::from_millis(300), move |event| {
                while active.load(Ordering::Acquire) == 0 {
                    std::thread::sleep(Duration::from_millis(10));
                }
                if active.load(Ordering::Acquire) != 1 {
                    return;
                }
                notify(notification(&watched, &root, generation, event));
                if !token.is_cancelled() {
                    publisher.schedule(Arc::clone(&watched), generation, token.clone());
                }
            })?;
        Ok(Self {
            vault,
            watch: Some(watch),
            status,
            generation,
            cancellation,
        })
    }

    pub(crate) fn publish(&self, publisher: &crate::publication::Publisher) {
        publisher.schedule(
            Arc::clone(&self.vault),
            self.generation,
            self.cancellation.clone(),
        );
    }

    pub(crate) fn activate(&self) {
        self.status.store(1, Ordering::Release);
    }
}

impl Drop for WatchedVault {
    fn drop(&mut self) {
        self.status.store(2, Ordering::Release);
        self.cancellation.cancel();
        self.watch.take();
    }
}

fn notification(
    vault: &Vault,
    root: &Path,
    generation: u64,
    event: std::result::Result<Vec<std::path::PathBuf>, String>,
) -> VaultEvent {
    let mut result = VaultEvent {
        generation,
        status: "changed".into(),
        paths: Vec::new(),
        healthy: true,
        message: None,
    };
    match event {
        Err(message) => {
            result.status = "watch-error".into();
            result.message = Some(message);
            result.healthy = false;
        }
        Ok(paths) => {
            match paths
                .into_iter()
                .filter_map(|path| {
                    path.strip_prefix(root)
                        .ok()
                        .map(noemori_vault::path_to_slashes)
                })
                .collect::<std::result::Result<Vec<_>, _>>()
            {
                Ok(paths) => result.paths = paths,
                Err(error) => {
                    result.status = "index-error".into();
                    result.message = Some(error.to_string());
                    result.healthy = false;
                }
            }
        }
    }
    if let Err(error) = vault.refresh_index() {
        if result.status == "changed" {
            result.status = "index-error".into();
        }
        result.message = Some(result.message.map_or_else(
            || error.to_string(),
            |message| format!("{message}；索引复核失败：{error}"),
        ));
        result.healthy = false;
    }
    result
}

#[cfg(test)]
#[path = "../../../../../test/notes/runtime/unit/watch.rs"]
mod tests;
