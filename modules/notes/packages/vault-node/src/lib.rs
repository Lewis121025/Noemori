//! Node-API 绑定：只适配 `noemori-runtime`，不在此层编排业务。

pub mod attachments;
pub mod bookmarks;
pub mod entries;
pub mod entry_batch;
pub mod files;
pub mod graph;
pub mod links;
pub mod metadata;
pub mod search;
pub mod vault;
mod runtime;
mod watch_events;
