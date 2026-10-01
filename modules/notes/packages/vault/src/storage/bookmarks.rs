//! 书签：用户整理的入口清单，存放在库内 `.noemori/bookmarks.json`。
//!
//! 书签是用户数据而不是派生索引，必须随库一起同步或备份，所以放在库内的点目录里
//! （扫描与文件树都跳过点目录）。写入走暂存文件加原子替换；改名事务提交后
//! 同步改写书签路径，失败时作为改名警告返回，不回滚已完成的改名。

use std::fs;
use std::io;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::storage::path::validate_relative_path;
use crate::storage::save::{read_optional, stage_bytes, sync_parent};
use crate::{Error, Vault};

/// 书签所在的库内点目录。
const DIRECTORY: &str = ".noemori";
/// 书签文件名。
const FILE: &str = "bookmarks.json";
/// 损坏文件在首次覆盖前的备份名。
const CORRUPT_BACKUP: &str = "bookmarks.corrupt.json";
/// 文件格式版本；读取时不认识的版本按损坏处理，避免旧程序覆盖新格式。
const FORMAT_VERSION: u32 = 1;

/// 一条书签。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Bookmark {
    /// 一篇笔记或附件。
    File {
        /// 库内相对路径。
        path: String,
        /// 自定义显示名；缺省用文件名。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
    },
    /// 一个文件夹。
    Folder {
        /// 库内相对路径。
        path: String,
        /// 自定义显示名；缺省用文件夹名。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
    },
    /// 笔记里的一个标题。
    Heading {
        /// 笔记的库内相对路径。
        path: String,
        /// 标题原文。
        heading: String,
        /// 自定义显示名；缺省用标题。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
    },
    /// 一次检索的查询文本。
    Search {
        /// 搜索框原文。
        query: String,
        /// 自定义显示名；缺省用查询文本。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
    },
}

impl Bookmark {
    fn path_mut(&mut self) -> Option<&mut String> {
        match self {
            Self::File { path, .. } | Self::Folder { path, .. } | Self::Heading { path, .. } => {
                Some(path)
            }
            Self::Search { .. } => None,
        }
    }

    fn validate(&self) -> Result<(), Error> {
        let invalid = |detail: &str| Error::InvalidBookmarks {
            detail: detail.to_string(),
        };
        match self {
            Self::File { path, .. } | Self::Folder { path, .. } | Self::Heading { path, .. } => {
                if path.is_empty() || path.starts_with('/') {
                    return Err(invalid("书签路径必须是库内相对路径"));
                }
                validate_relative_path(path)?;
                if let Self::Heading { heading, .. } = self {
                    if heading.trim().is_empty() {
                        return Err(invalid("标题书签缺少标题"));
                    }
                }
                Ok(())
            }
            Self::Search { query, .. } => {
                if query.trim().is_empty() {
                    Err(invalid("搜索书签缺少查询"))
                } else {
                    Ok(())
                }
            }
        }
    }
}

#[derive(Serialize, Deserialize)]
struct BookmarkFile {
    version: u32,
    items: Vec<Bookmark>,
}

impl Vault {
    fn bookmarks_path(&self) -> PathBuf {
        self.root().join(DIRECTORY).join(FILE)
    }

    /// 读出书签；文件不存在时为空。
    ///
    /// # Errors
    ///
    /// 读盘失败，或文件损坏、版本不认识（[`Error::InvalidBookmarks`]）。
    pub fn bookmarks(&self) -> Result<Vec<Bookmark>, Error> {
        Ok(load(&self.bookmarks_path())?.unwrap_or_default())
    }

    /// 整体替换书签清单。
    ///
    /// 现有文件损坏时先备份为 `bookmarks.corrupt.json` 再覆盖，用户手写的内容不会静默丢失。
    ///
    /// # Errors
    ///
    /// 书签路径越界或字段为空，或写盘失败。
    pub fn set_bookmarks(&self, items: &[Bookmark]) -> Result<(), Error> {
        for item in items {
            item.validate()?;
        }
        let _guard = self.lock_writes()?;
        let path = self.bookmarks_path();
        if let Err(Error::InvalidBookmarks { .. }) = load(&path) {
            fs::copy(&path, self.root().join(DIRECTORY).join(CORRUPT_BACKUP))?;
        }
        store(&path, items)
    }

    /// 改名事务提交后同步书签路径；调用方已持有写锁。
    ///
    /// 没有书签文件时什么也不做，不为改名创建空文件。
    pub(crate) fn remap_bookmarks_locked(&self, from: &str, to: &str) -> Result<(), Error> {
        let path = self.bookmarks_path();
        let Some(mut items) = load(&path)? else {
            return Ok(());
        };
        let mut changed = false;
        for item in &mut items {
            if let Some(current) = item.path_mut() {
                let mapped = if current == from {
                    Some(to.to_string())
                } else {
                    current
                        .strip_prefix(from)
                        .filter(|rest| rest.starts_with('/'))
                        .map(|rest| format!("{to}{rest}"))
                };
                if let Some(mapped) = mapped {
                    *current = mapped;
                    changed = true;
                }
            }
        }
        if changed {
            store(&path, &items)?;
        }
        Ok(())
    }
}

fn load(path: &std::path::Path) -> Result<Option<Vec<Bookmark>>, Error> {
    let Some(bytes) = read_optional(path)? else {
        return Ok(None);
    };
    let file: BookmarkFile =
        serde_json::from_slice(&bytes).map_err(|error| Error::InvalidBookmarks {
            detail: error.to_string(),
        })?;
    if file.version != FORMAT_VERSION {
        return Err(Error::InvalidBookmarks {
            detail: format!("不支持的书签格式版本 {}", file.version),
        });
    }
    Ok(Some(file.items))
}

fn store(path: &std::path::Path, items: &[Bookmark]) -> Result<(), Error> {
    let parent = path.parent().ok_or(Error::PathEscape)?;
    fs::create_dir_all(parent)?;
    let mut bytes = serde_json::to_vec_pretty(&BookmarkFile {
        version: FORMAT_VERSION,
        items: items.to_vec(),
    })
    .map_err(|error| Error::Io(io::Error::other(error.to_string())))?;
    bytes.push(b'\n');
    stage_bytes(parent, &bytes, None)?
        .persist(path)
        .map_err(|error| Error::Io(error.error))?;
    sync_parent(path)?;
    Ok(())
}
