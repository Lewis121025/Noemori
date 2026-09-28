//! 多文件改名的持久化意图。提交标记之前恢复旧内容，之后只清理记录。

use rusqlite::{params, OptionalExtension};
use std::collections::BTreeSet;

use crate::recovery::RecoveryStore;
use crate::Error;

pub(super) struct FileChange {
    pub path: String,
    pub before: Option<Vec<u8>>,
    pub after: Option<Vec<u8>>,
    pub permissions: u32,
    pub started: bool,
}

pub(super) struct RenameJournal {
    pub from: String,
    pub to: String,
    pub committed: bool,
    pub changes: Vec<FileChange>,
    pub directories: Vec<String>,
    /// 只有成功创建并记录的目录才允许回滚清理；旧日志缺乏归属证据时保留目录。
    pub created_directories: BTreeSet<String>,
}

impl RecoveryStore {
    pub(super) fn prepare_rename(&self, journal: &RenameJournal) -> Result<(), Error> {
        let mut conn = self.lock()?;
        let tx = conn.transaction().map_err(Error::Recovery)?;
        tx.execute(
            "INSERT INTO rename_operation (id, from_path, to_path, committed) VALUES (1, ?1, ?2, 0)",
            params![journal.from, journal.to],
        ).map_err(Error::Recovery)?;
        for (ordinal, change) in journal.changes.iter().enumerate() {
            tx.execute(
                "INSERT INTO rename_steps (ordinal, path, before_bytes, after_bytes, permissions, started)
                 VALUES (?1, ?2, ?3, ?4, ?5, 0)",
                params![i64::try_from(ordinal).map_err(|_| Error::Io(std::io::Error::other("改名步骤数量溢出")))?, change.path, change.before, change.after, change.permissions],
            ).map_err(Error::Recovery)?;
        }
        for (ordinal, path) in (0_i64..).zip(&journal.directories) {
            tx.execute(
                "INSERT INTO rename_directories VALUES (?1, ?2)",
                params![ordinal, path],
            )
            .map_err(Error::Recovery)?;
        }
        tx.commit().map_err(Error::Recovery)
    }

    pub(super) fn load_rename(&self) -> Result<Option<RenameJournal>, Error> {
        let conn = self.lock()?;
        let journal = conn
            .query_row(
                "SELECT from_path, to_path, committed FROM rename_operation WHERE id = 1",
                [],
                |row| {
                    Ok(RenameJournal {
                        from: row.get(0)?,
                        to: row.get(1)?,
                        committed: row.get(2)?,
                        changes: Vec::new(),
                        directories: Vec::new(),
                        created_directories: BTreeSet::new(),
                    })
                },
            )
            .optional()
            .map_err(Error::Recovery)?;
        let Some(mut journal) = journal else {
            return Ok(None);
        };
        let mut stmt = conn.prepare(
            "SELECT path, before_bytes, after_bytes, permissions, started FROM rename_steps ORDER BY ordinal",
        ).map_err(Error::Recovery)?;
        journal.changes = stmt
            .query_map([], |row| {
                Ok(FileChange {
                    path: row.get(0)?,
                    before: row.get(1)?,
                    after: row.get(2)?,
                    permissions: row.get(3)?,
                    started: row.get(4)?,
                })
            })
            .map_err(Error::Recovery)?
            .collect::<Result<_, _>>()
            .map_err(Error::Recovery)?;
        let mut stmt = conn
            .prepare("SELECT path FROM rename_directories ORDER BY ordinal")
            .map_err(Error::Recovery)?;
        journal.directories = stmt
            .query_map([], |row| row.get(0))
            .map_err(Error::Recovery)?
            .collect::<Result<_, _>>()
            .map_err(Error::Recovery)?;
        let mut stmt = conn
            .prepare("SELECT path FROM rename_created_directories")
            .map_err(Error::Recovery)?;
        journal.created_directories = stmt
            .query_map([], |row| row.get(0))
            .map_err(Error::Recovery)?
            .collect::<Result<_, _>>()
            .map_err(Error::Recovery)?;
        Ok(Some(journal))
    }

    /// 在独占创建目录成功后记录归属；写入失败时调用方必须清理刚创建的空目录。
    pub(super) fn record_created_directory(&self, path: &str) -> Result<(), Error> {
        self.lock()?
            .execute("INSERT INTO rename_created_directories VALUES (?1)", [path])
            .map_err(Error::Recovery)?;
        Ok(())
    }

    pub(super) fn start_rename_step(&self, ordinal: usize) -> Result<(), Error> {
        self.set_rename_step(ordinal, true)
    }

    pub(super) fn cancel_rename_step(&self, ordinal: usize) -> Result<(), Error> {
        self.set_rename_step(ordinal, false)
    }

    fn set_rename_step(&self, ordinal: usize, started: bool) -> Result<(), Error> {
        let ordinal = i64::try_from(ordinal)
            .map_err(|_| Error::Io(std::io::Error::other("改名步骤数量溢出")))?;
        self.lock()?
            .execute(
                "UPDATE rename_steps SET started = ?2 WHERE ordinal = ?1",
                params![ordinal, started],
            )
            .map_err(Error::Recovery)?;
        Ok(())
    }

    pub(super) fn commit_rename(&self) -> Result<(), Error> {
        self.lock()?
            .execute("UPDATE rename_operation SET committed = 1 WHERE id = 1", [])
            .map_err(Error::Recovery)?;
        Ok(())
    }

    pub(super) fn clear_rename(&self) -> Result<(), Error> {
        let mut conn = self.lock()?;
        let tx = conn.transaction().map_err(Error::Recovery)?;
        tx.execute_batch("DELETE FROM rename_steps; DELETE FROM rename_created_directories; DELETE FROM rename_directories; DELETE FROM rename_operation;")
            .map_err(Error::Recovery)?;
        tx.commit().map_err(Error::Recovery)
    }
}
