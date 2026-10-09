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
pub use service::Service;
