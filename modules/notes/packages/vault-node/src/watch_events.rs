//! 桥接线程只积累一次失效通知，JS 忙碌期间的事件在投递前合并。

use std::collections::BTreeSet;

use noemori_runtime::VaultEvent;

const MAX_PATHS: usize = 1024;
const MAX_PATH_BYTES: usize = 256 * 1024;
const MAX_MESSAGE_BYTES: usize = 2048;

/// None 表示没有已调度通知；取走内容后下一次 push 才能重新调度。
#[derive(Default)]
pub(crate) struct PendingNotification(Option<VaultEvent>);

impl PendingNotification {
    /// 合并路径及健康状态；返回是否需要调度一个 JS 回调。
    pub(crate) fn push(&mut self, mut event: VaultEvent) -> bool {
        // 旧发布任务可能晚于新库变更抵达；必须在替换待交付内容之前排除旧代次。
        if self
            .0
            .as_ref()
            .is_some_and(|old| old.generation > event.generation)
        {
            return false;
        }
        let schedule = self.0.is_none();
        if let Some(previous) = self
            .0
            .take()
            .filter(|old| old.generation == event.generation)
        {
            event.paths = merge_paths(previous.paths, event.paths);
            event.healthy &= previous.healthy;
            if previous.status != "changed" {
                event.status = previous.status;
                event.message = previous.message;
            }
        } else {
            event.paths = bounded_paths(event.paths);
        }
        if let Some(message) = &mut event.message {
            let mut end = message.len().min(MAX_MESSAGE_BYTES);
            while !message.is_char_boundary(end) {
                end -= 1;
            }
            message.truncate(end);
        }
        self.0 = Some(event);
        schedule
    }

    /// 在转换为 JS 参数时释放调度归属，允许新变化进入下一批。
    pub(crate) fn take(&mut self) -> Option<VaultEvent> {
        self.0.take()
    }
}

fn merge_paths(before: Vec<String>, after: Vec<String>) -> Vec<String> {
    if before.is_empty() || after.is_empty() {
        return Vec::new();
    }
    bounded_paths(before.into_iter().chain(after))
}

fn bounded_paths(paths: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut retained = BTreeSet::new();
    let mut bytes = 0;
    for path in paths {
        if retained.contains(&path) {
            continue;
        }
        if retained.len() >= MAX_PATHS || path.len() > MAX_PATH_BYTES - bytes {
            return Vec::new();
        }
        bytes += path.len();
        retained.insert(path);
    }
    retained.into_iter().collect()
}

#[cfg(test)]
#[path = "../../../../../test/notes/vault-node/unit/watch_events.rs"]
mod resource_tests;
