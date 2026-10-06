//! 工具注册、强类型参数与运行时 Schema 校验。

mod contract;
mod definition;
mod registry;
pub mod terminal;
pub mod web;

pub use contract::{Tool, ToolContext, ToolError};
pub use definition::ToolDefinition;
pub use registry::ToolRegistry;
