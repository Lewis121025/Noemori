use super::{TerminalNetworkConfig, TerminalNetworkDecision};
use crate::Error;
use serde::Serialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    os::unix::fs::FileTypeExt,
    path::{Path, PathBuf},
};

/// 冻结真实目标和解析所需的符号链接；读取链接文本不能变成读取替换后的普通文件。
#[derive(Clone, Serialize)]
pub(in crate::tool::terminal) struct Policy {
    pub(in crate::tool::terminal) rules: BTreeMap<PathBuf, TerminalNetworkDecision>,
    pub(in crate::tool::terminal) symlinks: BTreeSet<PathBuf>,
}

/// 路径授权指向规范化后的 socket 位置，不能让符号链接别名覆盖拒绝或变成目录授权。
pub(super) fn validate(config: &TerminalNetworkConfig) -> Result<Policy, Error> {
    if config.unix_sockets.len() > 64 {
        return Err(Error::Config("Unix socket 规则超过 64 项预算".into()));
    }
    let mut normalized = BTreeMap::new();
    let mut origins = Vec::new();
    for (source, decision) in &config.unix_sockets {
        let target = normalize(source)?;
        normalized
            .entry(target.clone())
            .and_modify(|current| {
                if *decision == TerminalNetworkDecision::Deny {
                    *current = *decision;
                }
            })
            .or_insert(*decision);
        if *decision == TerminalNetworkDecision::Allow {
            origins.push((source, target));
        }
    }
    let mut symlinks = BTreeSet::new();
    for (source, target) in origins {
        if normalized.get(&target) == Some(&TerminalNetworkDecision::Allow) {
            collect_symlinks(source, &mut symlinks, 0)?;
        }
    }
    #[cfg(not(target_os = "macos"))]
    if !config.unix_sockets.is_empty() || config.dangerously_allow_all_unix_sockets {
        return Err(Error::Unsupported(
            "当前平台尚无受控 Unix socket 路径代理；配置未生效，命令未执行".into(),
        ));
    }
    Ok(Policy {
        rules: normalized,
        symlinks,
    })
}

fn collect_symlinks(path: &Path, links: &mut BTreeSet<PathBuf>, depth: usize) -> Result<(), Error> {
    if depth > 40 || links.len() > 256 {
        return Err(Error::Config("Unix socket 符号链接解析超出预算".into()));
    }
    for prefix in path.ancestors() {
        if std::fs::symlink_metadata(prefix).is_ok_and(|metadata| metadata.file_type().is_symlink())
        {
            // vnode 路径先解析父目录别名；保留链接本身，不能把叶链接也解析成普通文件授权。
            let parent = prefix
                .parent()
                .ok_or_else(|| Error::Config("Unix 符号链接缺少父目录".into()))?;
            let name = prefix
                .file_name()
                .ok_or_else(|| Error::Config("Unix 符号链接缺少名称".into()))?;
            let source = parent
                .canonicalize()
                .map_err(|error| Error::Config(format!("Unix 符号链接父目录无法规范化：{error}")))?
                .join(name);
            let text = source
                .to_str()
                .ok_or_else(|| Error::Config("Unix 符号链接路径必须为 UTF-8".into()))?;
            if text.chars().any(char::is_control) {
                return Err(Error::Config("Unix 符号链接路径不能包含控制字符".into()));
            }
            links.insert(source);
            let target = std::fs::read_link(prefix)
                .map_err(|error| Error::Config(format!("Unix 符号链接无法读取：{error}")))?;
            let target = if target.is_absolute() {
                target
            } else {
                prefix
                    .parent()
                    .ok_or_else(|| Error::Config("Unix 符号链接缺少父目录".into()))?
                    .join(target)
            };
            collect_symlinks(&target, links, depth + 1)?;
        }
    }
    Ok(())
}

fn normalize(path: &Path) -> Result<PathBuf, Error> {
    let text = path
        .to_str()
        .ok_or_else(|| Error::Config("Unix socket 路径必须为 UTF-8".into()))?;
    if !path.is_absolute() || text.len() > 8192 || text.chars().any(char::is_control) {
        return Err(Error::Config(
            "Unix socket 路径必须绝对、无控制字符且不超过 8 KiB".into(),
        ));
    }
    let normalized = match std::fs::metadata(path) {
        Ok(metadata) => {
            if !metadata.file_type().is_socket() {
                return Err(Error::Config(
                    "Unix socket 规则不能指向普通文件或目录".into(),
                ));
            }
            path.canonicalize()
                .map_err(|error| Error::Config(format!("Unix socket 路径无法规范化：{error}")))?
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if std::fs::symlink_metadata(path)
                .is_ok_and(|metadata| metadata.file_type().is_symlink())
            {
                return Err(Error::Config("Unix socket 规则不能指向悬空符号链接".into()));
            }
            let name = path
                .file_name()
                .ok_or_else(|| Error::Config("Unix socket 路径缺少名称".into()))?;
            let parent = path
                .parent()
                .ok_or_else(|| Error::Config("Unix socket 路径缺少父目录".into()))?
                .canonicalize()
                .map_err(|error| Error::Config(format!("Unix socket 父目录无法规范化：{error}")))?;
            parent.join(name)
        }
        Err(error) => return Err(Error::Config(format!("Unix socket 路径无法读取：{error}"))),
    };
    if normalized
        .to_str()
        .is_none_or(|path| path.chars().any(char::is_control))
    {
        return Err(Error::Config(
            "规范化后的 Unix socket 路径必须为 UTF-8 且不含控制字符".into(),
        ));
    }
    nix::sys::socket::UnixAddr::new(&normalized)
        .map_err(|error| Error::Config(format!("Unix socket 路径超出系统地址预算：{error}")))?;
    Ok(normalized)
}
