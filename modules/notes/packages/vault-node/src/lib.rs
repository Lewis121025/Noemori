//! Node-API 薄绑定：适配资料库运行时，不在此层编排业务。

pub mod attachments;
pub mod bookmarks;
pub mod entries;
pub mod entry_batch;
pub mod export;
pub mod files;
pub mod links;
pub mod metadata;
mod runtime;
pub mod search;
pub mod vault;
mod watch_events;
