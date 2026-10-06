//! Noemori Agent 内核：模型协议、可取消的 ReAct 循环与可插拔工具。
//!
//! 模型与工具由调用方注入；单次运行独占历史，不依赖界面或笔记库。

#![deny(missing_docs)]

mod context;
mod error;
mod image;
pub mod llm;
mod media;
mod message;
pub mod runtime;
mod session;
pub mod tool;

pub use context::ExecutionContext;
pub use error::Error;
pub use image::{Image, ImageFormat};
pub use media::{Audio, AudioFormat, Media, MediaSource, Video, VideoFormat};
pub use message::{
    ContentPart, Message, ProviderData, Role, ToolCall, ToolResult, validate_history,
};
pub use session::AgentSession;
pub use tokio_util::sync::CancellationToken;
