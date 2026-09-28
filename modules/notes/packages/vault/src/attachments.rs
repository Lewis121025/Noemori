//! 附件只接收用户选择的字节，独占写入笔记旁的 attachments，不开放外部文件读取。
use crate::entries::validate_entry_path;
use crate::pathutil::{path_to_slashes, resolve_in_root};
use crate::save::{stage_bytes, sync_parent};
use crate::{EntryKind, Error, Vault};
use std::{
    fs, io,
    path::{Path, PathBuf},
};

/// 单次导入上限；限制跨进程字节复制的峰值内存，前端在读取 File 前应用同一预算。
pub const MAX_ATTACHMENT_BYTES: usize = 64 * 1024 * 1024;

/// 已独占提交的附件；后续索引失败不能把已存在的文件报告为导入失败。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportedAttachment {
    /// 附件实际的库内相对路径。
    pub path: String,
    /// 提交后同步或索引警告；None 表示全部完成。
    pub warning: Option<String>,
}

impl Vault {
    /// 将附件原始字节写入当前笔记同目录的 attachments；同名文件与草稿均保留。
    /// 返回实际库内路径及提交后警告；不修改笔记，也不在撤销引用时删除附件。
    /// # Errors
    /// 笔记不存在、名称或路径非法、超过大小预算、恢复事务受阻或写盘失败时拒绝。
    pub fn import_attachment(
        &self,
        from: &str,
        name: &str,
        bytes: &[u8],
    ) -> Result<ImportedAttachment, Error> {
        if bytes.len() > MAX_ATTACHMENT_BYTES {
            return Err(Error::Io(io::Error::other(
                "附件超过 64 MiB，请缩小文件后重试",
            )));
        }
        validate_entry_path(name)?;
        if name.contains('/') {
            return Err(Error::PathEscape);
        }
        let _guard = self.lock_writes()?;
        crate::rename::recover_pending(self.root(), &self.recovery)?;
        let (relative, directory, created) = self.attachment_directory(from)?;
        // 临时文件不继承同名附件权限；提交采用 no-clobber，同名竞争也只会另选名称。
        let mut staged = stage_bytes(&directory, bytes, None)?;
        let original = Path::new(name);
        let stem = original
            .file_stem()
            .and_then(|value| value.to_str())
            .ok_or(Error::PathEscape)?;
        let extension = original
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| format!(".{value}"))
            .unwrap_or_default();
        for number in 0_u64.. {
            let filename = if number == 0 {
                name.to_owned()
            } else {
                format!("{stem} ({number}){extension}")
            };
            let rel = path_to_slashes(&relative.join(filename))?;
            if self
                .recovery
                .conflicting_path(&rel, EntryKind::File, None)?
                .is_some()
            {
                continue;
            }
            let candidate = self.root().join(&rel);
            // 包含文件夹、断开的符号链接；不能跟随已有目标，也不能覆盖它们。
            match fs::symlink_metadata(&candidate) {
                Ok(_) => continue,
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
            match staged.persist_noclobber(&candidate) {
                Ok(_) => {
                    let mut warnings = Vec::new();
                    if created {
                        if let Err(error) = sync_parent(&directory) {
                            warnings.push(format!("附件文件夹同步失败：{error}"));
                        }
                    }
                    if let Some(warning) = self.finish_entry(&candidate).warning {
                        warnings.push(warning);
                    }
                    return Ok(ImportedAttachment {
                        path: rel,
                        warning: (!warnings.is_empty()).then(|| warnings.join("；")),
                    });
                }
                Err(error) if error.error.kind() == io::ErrorKind::AlreadyExists => {
                    staged = error.file;
                }
                Err(error) => return Err(error.error.into()),
            }
        }
        Err(Error::Io(io::Error::other(
            "附件同名数量过多，请更换文件名",
        )))
    }

    /// 写锁内准备目标目录，校验笔记归属和草稿占用；不递归创建失效的笔记父目录。
    fn attachment_directory(&self, from: &str) -> Result<(PathBuf, PathBuf, bool), Error> {
        let note = resolve_in_root(self.root(), from)?;
        if !fs::metadata(&note)?.is_file()
            || !note
                .extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
        {
            return Err(Error::Io(io::Error::other(
                "请从现有 Markdown 笔记插入附件",
            )));
        }
        let relative = note
            .strip_prefix(self.root())
            .map_err(|_| Error::PathEscape)?
            .parent()
            .ok_or(Error::PathEscape)?
            .join("attachments");
        let directory_rel = path_to_slashes(&relative)?;
        let directory = resolve_in_root(self.root(), &directory_rel)?;
        if self
            .recovery
            .conflicting_path(&directory_rel, EntryKind::Directory, None)?
            .is_some()
        {
            return Err(Error::Io(io::Error::other(
                "附件文件夹被恢复草稿占用，请先恢复草稿",
            )));
        }
        let created = match fs::create_dir(&directory) {
            Ok(()) => true,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists && directory.is_dir() => {
                false
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                return Err(Error::Io(io::Error::other(
                    "attachments 已被文件占用，请重命名该文件后重试",
                )));
            }
            Err(error) => return Err(error.into()),
        };
        Ok((relative, directory, created))
    }
}
