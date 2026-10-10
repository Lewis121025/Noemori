//! 纯 Rust 原生能力边界；系统指针与回调均留在此独立 crate。
#![deny(unsafe_code)]
#[cfg(target_os = "macos")]
#[allow(unsafe_code)]
mod ax;
#[cfg(target_os = "macos")]
mod geometry;
#[cfg(target_os = "macos")]
#[allow(unsafe_code)]
mod input;
#[cfg(target_os = "macos")]
#[allow(unsafe_code)]
mod screen;
#[cfg(target_os = "macos")]
mod service;
#[cfg(target_os = "macos")]
#[path = "text-selection.rs"]
mod text_selection;
#[cfg(target_os = "macos")]
mod clipboard;
#[cfg(target_os = "macos")]
#[path = "paste-lifecycle.rs"]
mod paste_lifecycle;
#[cfg(target_os = "macos")]
#[path = "pending-paste.rs"]
mod pending_paste;
#[cfg(target_os = "macos")]
#[allow(unsafe_code)]
mod launch;
#[cfg(target_os = "macos")]
mod observation;
#[cfg(target_os = "macos")]
pub use service::Service;
