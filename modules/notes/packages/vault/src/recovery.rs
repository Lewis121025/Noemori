//! 未提交的编辑单独持久化，链接索引故障不能破坏恢复记录。

use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};

use crate::{EntryKind, Error};

/// 一次保存尝试的完整内容及其编辑基准。
#[derive(Debug)]
pub struct Draft {
    /// 普通草稿为最新编辑字节；存在 editor 时为重建源码映射的原始字节。
    pub bytes: Vec<u8>,
    /// 编辑基准；`None` 表示文件原先不存在。
    pub base: Option<Vec<u8>>,
    /// 无法生成 Markdown 时的编辑器恢复数据；内核原样保存，由对应版本的编辑器验证。
    pub editor: Option<String>,
}

impl Draft {
    /// 编辑器快照不能仅凭原始源码相同就视为已提交，保存、删除、改名共用此判断。
    pub(super) fn is_committed(&self, disk: Option<&[u8]>) -> bool {
        self.editor.is_none() && disk == Some(self.bytes.as_slice())
    }
}

pub(super) struct RecoveryStore(Mutex<Connection>);

impl RecoveryStore {
    pub(super) fn open(path: &Path) -> Result<Self, Error> {
        let mut conn = Connection::open(path).map_err(Error::Recovery)?;
        conn.execute_batch("PRAGMA synchronous = FULL;")
            .map_err(Error::Recovery)?;
        let transaction = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(Error::Recovery)?;
        transaction
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS drafts (
                 path TEXT PRIMARY KEY, bytes BLOB NOT NULL, base BLOB
             );
             CREATE TABLE IF NOT EXISTS rename_operation (
                 id INTEGER PRIMARY KEY CHECK (id = 1), from_path TEXT NOT NULL,
                 to_path TEXT NOT NULL, committed INTEGER NOT NULL CHECK (committed IN (0, 1))
             );
             CREATE TABLE IF NOT EXISTS rename_steps (
                 ordinal INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE,
                 before_bytes BLOB, after_bytes BLOB, permissions INTEGER NOT NULL,
                 started INTEGER NOT NULL CHECK (started IN (0, 1))
             );
             CREATE TABLE IF NOT EXISTS rename_directories (
                 ordinal INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE
             );
             CREATE TABLE IF NOT EXISTS rename_created_directories (
                 path TEXT PRIMARY KEY
             );",
            )
            .map_err(Error::Recovery)?;
        // 原表只追加可空列，旧草稿和改名日志原样保留；迁移失败回滚，禁止清空状态目录。
        let has_editor: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('drafts') WHERE name = 'editor')",
                [],
                |row| row.get(0),
            )
            .map_err(Error::Recovery)?;
        if !has_editor {
            transaction
                .execute("ALTER TABLE drafts ADD COLUMN editor TEXT", [])
                .map_err(Error::Recovery)?;
        }
        transaction.commit().map_err(Error::Recovery)?;
        Ok(Self(Mutex::new(conn)))
    }

    pub(super) fn lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>, Error> {
        self.0
            .lock()
            .map_err(|_| Error::Io(std::io::Error::other("恢复记录锁已毒化")))
    }

    pub(super) fn put(&self, path: &str, bytes: &[u8], base: Option<&[u8]>) -> Result<(), Error> {
        self.put_editor(path, bytes, base, None)
    }

    pub(super) fn put_editor(
        &self,
        path: &str,
        bytes: &[u8],
        base: Option<&[u8]>,
        editor: Option<&str>,
    ) -> Result<(), Error> {
        if let Some(draft) = self.conflicting_path(path, EntryKind::File, Some(path))? {
            return Err(Error::Io(std::io::Error::other(format!(
                "路径被恢复草稿占用，请先处理：{draft}"
            ))));
        }
        self.lock()?
            .execute(
                "INSERT INTO drafts (path, bytes, base, editor) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(path) DO UPDATE SET bytes = excluded.bytes, base = excluded.base, editor = excluded.editor",
                params![path, bytes, base, editor],
            )
            .map_err(Error::Recovery)?;
        Ok(())
    }

    /// 检查相对路径与草稿的文件／目录占用关系，返回冲突草稿的原始路径。
    ///
    /// 文件占用自身和所有父目录；新建目录可以恢复草稿的缺失父目录。
    /// `excluding` 仅允许更新指定草稿，调用方须持有库写入锁以避免检查后竞态。
    /// 比较路径分量时忽略 `.`，避免同名前缀误判；恢复记录不可读时返回错误。
    pub(super) fn conflicting_path(
        &self,
        path: &str,
        kind: EntryKind,
        excluding: Option<&str>,
    ) -> Result<Option<String>, Error> {
        let normalize = |path: &str| -> PathBuf {
            Path::new(path)
                .components()
                .filter(|part| *part != Component::CurDir)
                .collect()
        };
        let path = normalize(path);
        for draft in self.paths()? {
            if excluding == Some(draft.as_str()) {
                continue;
            }
            let draft_path = normalize(&draft);
            if path.starts_with(&draft_path)
                || (kind == EntryKind::File && draft_path.starts_with(&path))
            {
                return Ok(Some(draft));
            }
        }
        Ok(None)
    }

    pub(super) fn get(&self, path: &str) -> Result<Option<Draft>, Error> {
        self.lock()?
            .query_row(
                "SELECT bytes, base, editor FROM drafts WHERE path = ?1",
                [path],
                |row| {
                    Ok(Draft {
                        bytes: row.get(0)?,
                        base: row.get(1)?,
                        editor: row.get(2)?,
                    })
                },
            )
            .optional()
            .map_err(Error::Recovery)
    }

    pub(super) fn remove(&self, path: &str) -> Result<(), Error> {
        self.lock()?
            .execute("DELETE FROM drafts WHERE path = ?1", [path])
            .map_err(Error::Recovery)?;
        Ok(())
    }

    pub(super) fn paths(&self) -> Result<Vec<String>, Error> {
        let conn = self.lock()?;
        let mut stmt = conn
            .prepare("SELECT path FROM drafts ORDER BY path")
            .map_err(Error::Recovery)?;
        let paths = stmt
            .query_map([], |row| row.get(0))
            .map_err(Error::Recovery)?
            .collect::<Result<_, _>>()
            .map_err(Error::Recovery)?;
        Ok(paths)
    }
}
