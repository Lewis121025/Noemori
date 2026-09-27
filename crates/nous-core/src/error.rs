//! 内核错误。

use std::io;
use std::path::PathBuf;

/// 库内核可恢复失败。
///
/// 路径越界单独成类，避免与 IO 混淆；调用方必须拒绝而不是尝试「规范化」后再读。
#[derive(Debug)]
pub enum Error {
    /// 相对路径含 `..`、绝对路径或解析后逃出库根。
    PathEscape,
    /// 目标文件不存在。
    NotFound { path: PathBuf },
    /// 底层 IO。
    Io(io::Error),
    /// `SQLite` 索引失败。
    Index(rusqlite::Error),
    /// 编辑草稿或文件操作恢复记录的持久化、读取失败。
    Recovery(rusqlite::Error),
    /// 改名目标已存在。
    AlreadyExists { path: PathBuf },
    /// 改名计划读取后，磁盘内容又发生变化。
    FileChanged { path: PathBuf },
    /// 改名恢复尚未完成，日志必须保留以便重试。
    RenameRecovery { detail: String },
    /// 检索条件无法执行（如正则表达式无效）。
    InvalidQuery { detail: String },
    /// 书签文件损坏或书签内容不合法。
    InvalidBookmarks { detail: String },
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::PathEscape => write!(f, "路径逃出库根"),
            Self::NotFound { path } => write!(f, "文件不存在: {}", path.display()),
            Self::Io(err) => write!(f, "{err}"),
            Self::Index(err) => write!(f, "索引: {err}"),
            Self::Recovery(err) => write!(f, "恢复记录: {err}"),
            Self::AlreadyExists { path } => write!(f, "目标已存在: {}", path.display()),
            Self::FileChanged { path } => write!(f, "文件已被外部修改: {}", path.display()),
            Self::RenameRecovery { detail } => write!(f, "改名恢复未完成：{detail}"),
            Self::InvalidQuery { detail } => write!(f, "{detail}"),
            Self::InvalidBookmarks { detail } => write!(f, "书签无效：{detail}"),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(err) => Some(err),
            Self::Index(err) | Self::Recovery(err) => Some(err),
            Self::PathEscape
            | Self::NotFound { .. }
            | Self::AlreadyExists { .. }
            | Self::FileChanged { .. }
            | Self::RenameRecovery { .. }
            | Self::InvalidQuery { .. }
            | Self::InvalidBookmarks { .. } => None,
        }
    }
}

impl From<io::Error> for Error {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<rusqlite::Error> for Error {
    fn from(value: rusqlite::Error) -> Self {
        Self::Index(value)
    }
}
