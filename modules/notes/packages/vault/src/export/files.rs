//! 导出读取使用目录句柄逐级打开，避免符号链接替换导致库外读取。

use super::hex_digest;
use crate::storage::path::{path_to_slashes, validate_relative_path};
use crate::{EntryKind, Error, VaultEntry};
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::os::unix::fs::MetadataExt;
use std::{fs, io::Seek, path::Path};

pub(super) fn failure(message: impl Into<String>) -> Error {
    Error::Io(std::io::Error::other(message.into()))
}

#[derive(PartialEq, Eq)]
pub(super) struct Identity {
    pub len: u64,
    modified: std::time::SystemTime,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
}

impl Identity {
    pub fn read(file: &fs::File) -> Result<Self, Error> {
        let metadata = file.metadata()?;
        if !metadata.is_file() {
            return Err(failure("导出只支持普通文件"));
        }
        Ok(Self {
            len: metadata.len(),
            modified: metadata.modified()?,
            #[cfg(unix)]
            device: metadata.dev(),
            #[cfg(unix)]
            inode: metadata.ino(),
        })
    }
}

pub(super) fn open_source(root: &Path, relative: &str) -> Result<fs::File, Error> {
    let path = validate_relative_path(relative)?;
    #[cfg(target_os = "macos")]
    {
        use rustix::fs::{openat, Mode, OFlags};
        let mut directory = open_root(root)?;
        let parts: Vec<_> = path.iter().collect();
        for (index, part) in parts.iter().enumerate() {
            let flags = OFlags::RDONLY
                | OFlags::NOFOLLOW
                | OFlags::CLOEXEC
                | OFlags::NONBLOCK
                | if index + 1 == parts.len() {
                    OFlags::empty()
                } else {
                    OFlags::DIRECTORY
                };
            let fd =
                openat(&directory, *part, flags, Mode::empty()).map_err(std::io::Error::from)?;
            directory = fs::File::from(fd);
        }
        Ok(directory)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (root, path);
        Err(failure("导出文件事务目前仅在 macOS 上通过验收"))
    }
}

/// 从文件系统根逐级打开库根，祖先或库根的符号链接置换也不能越过读取边界。
fn open_root(root: &Path) -> Result<fs::File, Error> {
    #[cfg(target_os = "macos")]
    {
        use rustix::fs::{open, openat, Mode, OFlags};
        use std::path::Component;
        if !root.is_absolute() {
            return Err(Error::PathEscape);
        }
        let flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
        let mut directory =
            fs::File::from(open("/", flags, Mode::empty()).map_err(std::io::Error::from)?);
        for part in root.components() {
            match part {
                Component::RootDir => {}
                Component::Normal(name) => {
                    directory = fs::File::from(
                        openat(&directory, name, flags, Mode::empty())
                            .map_err(std::io::Error::from)?,
                    );
                }
                _ => return Err(Error::PathEscape),
            }
        }
        Ok(directory)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = root;
        Err(failure("导出文件事务目前仅在 macOS 上通过验收"))
    }
}

pub(super) fn hash_bytes(bytes: &[u8]) -> String {
    hex_digest(&Sha256::digest(bytes))
}

pub(super) fn hash_reader(
    source: &mut fs::File,
    progress: &mut dyn FnMut(usize) -> Result<(), Error>,
) -> Result<(String, u64), Error> {
    source.rewind()?;
    crate::storage::hash::transfer_hashed(source, &mut std::io::sink(), u64::MAX, progress)
}

pub(super) fn copy_source(
    source: &mut fs::File,
    destination: &Path,
    progress: &mut dyn FnMut(usize) -> Result<(), Error>,
) -> Result<(String, u64), Error> {
    source.rewind()?;
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)?;
    let result = crate::storage::hash::transfer_hashed(
        source,
        &mut output,
        super::EXPORT_BYTE_LIMIT,
        progress,
    )?;
    output.sync_all()?;
    Ok(result)
}

/// 枚举期间即可取消和拒绝超限；不先把无限大的目录树收进内存。
pub(super) fn selected_entries(
    root: &Path,
    selected: Option<&[String]>,
    hidden: bool,
    limited: bool,
    progress: &mut dyn FnMut(usize) -> Result<(), Error>,
) -> Result<Vec<VaultEntry>, Error> {
    let mut enumeration = Enumeration {
        root,
        hidden,
        limited,
        progress,
        entries: std::collections::BTreeMap::new(),
        files: 0,
        bytes: 0,
    };
    match selected {
        None => enumeration.visit(root)?,
        Some(paths) => {
            for path in paths {
                let relative = validate_relative_path(path)?;
                crate::storage::path::resolve_in_root(root, path)?;
                enumeration.visit(&root.join(relative))?;
            }
        }
    }
    Ok(enumeration.entries.into_values().collect())
}

struct Enumeration<'a> {
    root: &'a Path,
    hidden: bool,
    limited: bool,
    progress: &'a mut dyn FnMut(usize) -> Result<(), Error>,
    entries: std::collections::BTreeMap<String, VaultEntry>,
    files: usize,
    bytes: u64,
}

impl Enumeration<'_> {
    fn visit(&mut self, path: &Path) -> Result<(), Error> {
        if !self.record(path)? {
            return Ok(());
        }
        // 只排队目录路径，普通文件立即计入预算；不持有随目录深度增长的打开句柄。
        #[cfg(target_os = "macos")]
        {
            use std::{ffi::OsStr, os::unix::ffi::OsStrExt};
            let mut pending = vec![path.to_path_buf()];
            while let Some(path) = pending.pop() {
                let handle = self.open(&path)?;
                let directory =
                    rustix::fs::Dir::read_from(&handle).map_err(std::io::Error::from)?;
                for item in directory {
                    let item = item.map_err(std::io::Error::from)?;
                    let name = OsStr::from_bytes(item.file_name().to_bytes());
                    if name == "."
                        || name == ".."
                        || (!self.hidden && name.to_string_lossy().starts_with('.'))
                    {
                        continue;
                    }
                    let child = path.join(name);
                    if self.record(&child)? {
                        pending.push(child);
                    }
                }
            }
        }
        Ok(())
    }

    fn open(&self, path: &Path) -> Result<fs::File, Error> {
        if path == self.root {
            return open_root(self.root);
        }
        let relative = path_to_slashes(
            path.strip_prefix(self.root)
                .map_err(|_| Error::PathEscape)?,
        )?;
        open_source(self.root, &relative)
    }

    fn record(&mut self, path: &Path) -> Result<bool, Error> {
        (self.progress)(0)?;
        let handle = self.open(path)?;
        let metadata = handle.metadata()?;
        if metadata.file_type().is_symlink() || (!metadata.is_file() && !metadata.is_dir()) {
            return Err(failure(format!(
                "导出范围包含符号链接或特殊文件：{}",
                path.display()
            )));
        }
        if path != self.root {
            let relative = path_to_slashes(
                path.strip_prefix(self.root)
                    .map_err(|_| Error::PathEscape)?,
            )?;
            if self.entries.contains_key(&relative) {
                return Ok(false);
            }
            if metadata.is_file() {
                self.files += 1;
                self.bytes = self
                    .bytes
                    .checked_add(metadata.len())
                    .ok_or_else(|| failure("导出字节计数溢出"))?;
                if self.limited
                    && (self.files > super::EXPORT_FILE_LIMIT
                        || self.bytes > super::EXPORT_BYTE_LIMIT)
                {
                    return Err(failure("导出超过 10000 个文件或 5 GiB 源数据"));
                }
            }
            self.entries.insert(
                relative.clone(),
                VaultEntry {
                    path: relative,
                    kind: if metadata.is_dir() {
                        EntryKind::Directory
                    } else {
                        EntryKind::File
                    },
                    recovery_only: false,
                    modified_at: None,
                },
            );
        }
        Ok(metadata.is_dir())
    }
}
