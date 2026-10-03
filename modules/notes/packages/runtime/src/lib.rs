//! 不依赖宿主的应用运行时：顺序写入、受控读取、会话和库生命周期。

mod batch;
mod control;
mod export;
mod files;
mod models;
mod publication;
mod scheduler;
pub mod session;
mod state;
mod watch;

pub use control::{OperationControl, Progress};
pub use scheduler::{Pending, Runtime};
pub use state::{State, VaultEvent};

/// 运行时错误保持磁盘失败、失效请求与停机的边界，不重放结果未知的写入。
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// 文件系统或会话提交失败。
    #[error(transparent)]
    Io(#[from] std::io::Error),
    /// Vault 保持原始错误含义。
    #[error(transparent)]
    Vault(#[from] noemori_vault::Error),
    /// 生命周期或调度约束不满足。
    #[error("{0}")]
    State(String),
}

/// 业务结果；文件提交后的派生错误仍由各操作自己的 warning 表达。
pub type Result<T> = std::result::Result<T, Error>;
