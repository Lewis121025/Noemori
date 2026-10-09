//! 应用仓库固定在宿主提供的位置；旧库导入副本后，阅读现场和草稿一并接入。
use crate::{Error, OperationControl, Result, State, directory_import, state::Restoration};
use noemori_vault::Vault;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{fs, io::Write, path::Path};

/// 迁移意图在目录发布前持久化，重启可以继续接入同一份完整副本。
#[derive(Serialize, Deserialize)]
struct Migration {
    source: String,
    root: String,
    path: String,
    marker: String,
}

fn save_migration(path: &Path, migration: &Migration) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| Error::State("迁移记录缺少父目录".into()))?;
    fs::create_dir_all(parent)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    temporary.write_all(&serde_json::to_vec(migration).map_err(std::io::Error::other)?)?;
    temporary.as_file().sync_all()?;
    temporary.persist(path).map_err(|error| error.error)?;
    Ok(())
}

impl State {
    /// 导入一个完整目录副本；文件和空目录不合并、不覆盖，原资料保持原位。
    /// # Errors
    /// 库归属、源目录、目标或复制错误在提交前拒绝；提交后索引错误放入 warning。
    pub fn import_directory(
        &self,
        root: &str,
        source: &str,
        parent: &str,
        control: &OperationControl,
    ) -> Result<Value> {
        self.require_root(root)?;
        let Some(prepared) =
            directory_import::prepare(self.vault()?.root(), Path::new(source), parent, control)?
        else {
            return Ok(Value::Null);
        };
        let Some(mut imported) = prepared.commit(control)? else {
            return Ok(Value::Null);
        };
        if let Err(error) = self.vault()?.refresh_index() {
            imported.warning = Some(
                [
                    imported.warning,
                    Some(format!("副本已导入，索引刷新失败：{error}")),
                ]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join("；"),
            );
        }
        self.changed(Vec::new(), imported.warning.is_none());
        Ok(json!({"path": imported.path, "files": imported.files, "warning": imported.warning}))
    }

    /// 启动固定应用仓库；旧单目录会话迁移为子目录，重复启动不重复复制。
    /// # Errors
    /// 原资料不可读、目录副本或会话提交失败时保留原资料和迁移记录，可重试。
    pub fn restore_library(&mut self, root: &str, control: &OperationControl) -> Result<Value> {
        if control.cancelled() {
            return Ok(Value::Null);
        }
        let session = self.sessions.load();
        let mut reader = session["reader"].clone();
        if let Some(source) = reader["vaultRoot"].as_str() {
            if !Path::new(source).is_dir() {
                return Err(Error::State(format!(
                    "上次的资料目录无法访问：{source}。请恢复目录后重试。"
                )));
            }
        }
        fs::create_dir_all(root)?;
        let Some(source) = reader["vaultRoot"].as_str().map(str::to_owned) else {
            return self.open_restoring(
                root,
                control,
                Some(Restoration {
                    reader,
                    drafts: Vec::new(),
                }),
            );
        };
        if Path::new(&source).canonicalize()? == Path::new(root).canonicalize()? {
            return self.open(&source, true, control);
        }
        let old =
            Vault::open_with_progress(&source, self.index_directory(&source), &mut |progress| {
                control.update("recovering", progress.completed, progress.total);
                Ok(!control.cancelled())
            });
        let old = match old {
            Ok(vault) => vault,
            Err(noemori_vault::Error::OpenCancelled) => return Ok(Value::Null),
            Err(error) => return Err(error.into()),
        };
        let drafts = old.recovery_drafts()?;
        let receipt = self.user_data.join("library-migration.json");
        let existing: Option<Migration> = match fs::read(&receipt) {
            Ok(bytes) => Some(
                serde_json::from_slice(&bytes)
                    .map_err(|error| Error::State(format!("仓库迁移记录无法读取：{error}")))?,
            ),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        let completed = if let Some(migration) = existing {
            if migration.source != source
                || migration.root != root
                || !crate::session::entry_path(&migration.path)
                || !migration.marker.starts_with(".noemori-migration-")
                || migration.marker.contains('/')
            {
                return Err(Error::State(
                    "仓库迁移归属发生变化，请先恢复原资料目录".into(),
                ));
            }
            let target = Path::new(root).join(&migration.path);
            if target.try_exists()? {
                let marker: Migration =
                    serde_json::from_slice(&fs::read(target.join(&migration.marker))?)
                        .map_err(std::io::Error::other)?;
                if marker.source != source
                    || marker.root != root
                    || marker.path != migration.path
                    || marker.marker != migration.marker
                {
                    return Err(Error::State(
                        "仓库中的迁移副本归属不一致，未覆盖任何文件".into(),
                    ));
                }
                Some(migration)
            } else {
                None
            }
        } else {
            None
        };
        let migration = match completed {
            Some(migration) => {
                if !control.commit() {
                    return Ok(Value::Null);
                }
                migration
            }
            None => {
                let Some(prepared) =
                    directory_import::prepare(Path::new(root), Path::new(&source), "", control)?
                else {
                    return Ok(Value::Null);
                };
                let digest: String = Sha256::digest(
                    format!("{source}\n{root}\n{}", prepared.target.display()).as_bytes(),
                )
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect();
                let migration = Migration {
                    source: source.clone(),
                    root: root.to_owned(),
                    path: prepared.path.clone(),
                    marker: format!(".noemori-migration-{}", &digest[..16]),
                };
                prepared.mark(
                    &migration.marker,
                    &serde_json::to_vec(&migration).map_err(std::io::Error::other)?,
                )?;
                save_migration(&receipt, &migration)?;
                if prepared.commit(control)?.is_none() {
                    return Ok(Value::Null);
                }
                migration
            }
        };
        crate::session::prefix_reader(&mut reader, &migration.path);
        let drafts = drafts
            .into_iter()
            .map(|(path, draft)| (format!("{}/{path}", migration.path), draft))
            .collect();
        // 目录已经发布，后续接入不能取消；失败保留可核实的副本与意图，重启继续同一份副本。
        let mut result = self.open_restoring(
            root,
            &OperationControl::default(),
            Some(Restoration { reader, drafts }),
        )?;
        result["imported"] = json!({"source": source, "path": migration.path});
        match fs::remove_file(&receipt) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                result["warning"] = json!(format!("仓库已恢复，迁移记录清理失败：{error}"))
            }
        }
        Ok(result)
    }
}
