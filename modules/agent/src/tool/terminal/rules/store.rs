use super::{
    MAX_RULES, MAX_STORE_BYTES, TerminalApprovalRequest, TerminalApprovalRule,
    TerminalPermissionGrant,
};
use crate::Error;
use serde::{Deserialize, Serialize};
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct StoredRules {
    version: u32,
    rules: Vec<TerminalApprovalRule>,
}

/// 宿主独占的持久审批规则库；模型不能指定路径，工具会拒绝让命令写入该文件的授权。
/// 每次修改先完成原子磁盘提交再发布内存状态，保存失败不会降级为自动允许。
pub struct TerminalApprovalStore {
    path: PathBuf,
    rules: Mutex<Vec<TerminalApprovalRule>>,
    // 锁文件不随 JSON 原子替换，也不在释放时删除，避免两个实例分别锁住不同 inode。
    _lock: ApprovalLock,
}

/// flock 归属打开的文件描述，而非进程；释放时显式解锁，避免 fork 子进程延长许可锁寿命。
struct ApprovalLock {
    file: std::fs::File,
}

impl Drop for ApprovalLock {
    fn drop(&mut self) {
        if let Err(error) = self.file.unlock() {
            eprintln!("审批规则锁释放失败：{error}");
        }
    }
}

impl TerminalApprovalStore {
    /// 打开规则文件；不存在时建立空的内存规则库，直到明确批准持久规则才创建文件。
    /// # 错误
    /// 父目录不存在、已被其他实例占用、文件是符号链接或内容无效/超预算时返回配置或 I/O 错误。
    pub fn open(path: impl AsRef<Path>) -> Result<Self, Error> {
        let absolute = std::path::absolute(path.as_ref())
            .map_err(|e| Error::Config(format!("规则库路径无效：{e}")))?;
        let parent = absolute
            .parent()
            .ok_or_else(|| Error::Config("规则库缺少父目录".into()))?
            .canonicalize()
            .map_err(|e| Error::Config(format!("规则库父目录无效：{e}")))?;
        let filename = absolute
            .file_name()
            .ok_or_else(|| Error::Config("规则库缺少文件名".into()))?;
        let path = parent.join(filename);
        let lock = exclusive_lock(&path)?;
        let rules = load(&path)?;
        Ok(Self {
            path,
            rules: Mutex::new(rules),
            _lock: lock,
        })
    }

    /// 返回可审查的规则快照，包含前缀、范围与撤销标识，不返回明文环境变量。
    pub fn rules(&self) -> Vec<TerminalApprovalRule> {
        self.rules.lock().expect("持久审批锁被污染").clone()
    }

    /// 撤销一条持久授权；成功返回是否找到该规则，不中断此前已批准的进程。
    /// # 错误
    /// 原子替换前失败保留原状态；替换后目录持久化失败时撤销已生效，并明确报告错误。
    pub fn revoke(&self, id: &str) -> Result<bool, Error> {
        let mut rules = self.rules.lock().expect("持久审批锁被污染");
        if !rules.iter().any(|rule| rule.id == id) {
            return Ok(false);
        }
        let mut next = rules.clone();
        next.retain(|rule| rule.id != id);
        self.commit(&mut rules, next)?;
        Ok(true)
    }

    pub(in crate::tool::terminal) fn path(&self) -> &Path {
        &self.path
    }

    pub(in crate::tool::terminal) fn allows(
        &self,
        request: &TerminalApprovalRequest,
        grant: &TerminalPermissionGrant,
    ) -> bool {
        self.rules
            .lock()
            .expect("持久审批锁被污染")
            .iter()
            .any(|rule| rule.matches(request, grant))
    }

    pub(in crate::tool::terminal) fn insert(
        &self,
        rule: TerminalApprovalRule,
    ) -> Result<(), Error> {
        rule.validate().map_err(Error::Config)?;
        let mut rules = self.rules.lock().expect("持久审批锁被污染");
        if rules.len() >= MAX_RULES {
            return Err(Error::Config("持久审批规则已达到 256 项上限".into()));
        }
        let mut next = rules.clone();
        next.push(rule);
        self.commit(&mut rules, next)?;
        Ok(())
    }

    fn commit(
        &self,
        rules: &mut Vec<TerminalApprovalRule>,
        next: Vec<TerminalApprovalRule>,
    ) -> Result<(), Error> {
        let bytes = serde_json::to_vec_pretty(&StoredRules {
            version: 1,
            rules: next.clone(),
        })
        .map_err(|e| Error::Config(format!("审批规则编码失败：{e}")))?;
        if bytes.len() > MAX_STORE_BYTES {
            return Err(Error::Config("审批规则文件超过 1 MiB 预算".into()));
        }
        let parent = self.path.parent().expect("规则库构造时已校验父目录");
        let write = || -> std::io::Result<()> {
            let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
            temporary.write_all(&bytes)?;
            temporary.as_file().sync_all()?;
            temporary.persist(&self.path).map_err(|error| error.error)?;
            Ok(())
        };
        write().map_err(|e| Error::ToolInfrastructure(format!("审批规则持久化失败：{e}")))?;
        // 命名空间已提交后立即发布同样的内存状态；后续目录刷盘失败不能恢复已撤销的授权。
        *rules = next;
        std::fs::File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|e| {
                Error::ToolInfrastructure(format!("审批规则已提交，但未能确认目录持久化：{e}"))
            })
    }
}

fn load(path: &Path) -> Result<Vec<TerminalApprovalRule>, Error> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(Error::Config(format!("审批规则文件无法读取：{error}"))),
    };
    if !metadata.is_file() {
        return Err(Error::Config(
            "审批规则库必须是普通文件，不能跟随符号链接".into(),
        ));
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .and_then(|file| {
            file.take((MAX_STORE_BYTES + 1) as u64)
                .read_to_end(&mut bytes)
        })
        .map_err(|e| Error::Config(format!("审批规则文件读取失败：{e}")))?;
    if bytes.len() > MAX_STORE_BYTES {
        return Err(Error::Config("审批规则文件超过 1 MiB 预算".into()));
    }
    let stored: StoredRules = serde_json::from_slice(&bytes)
        .map_err(|e| Error::Config(format!("审批规则文件无效：{e}")))?;
    if stored.version != 1 || stored.rules.len() > MAX_RULES {
        return Err(Error::Config("审批规则版本不支持或数量超过上限".into()));
    }
    let mut ids = std::collections::BTreeSet::new();
    for rule in &stored.rules {
        rule.validate().map_err(Error::Config)?;
        if !ids.insert(&rule.id) {
            return Err(Error::Config("审批规则标识重复".into()));
        }
    }
    Ok(stored.rules)
}

fn exclusive_lock(path: &Path) -> Result<ApprovalLock, Error> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut name = path
        .file_name()
        .expect("规则库已经验证文件名")
        .to_os_string();
    name.push(".lock");
    let path = path.with_file_name(name);
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(nix::libc::O_NOFOLLOW)
        .open(path)
        .map_err(|e| Error::Config(format!("审批规则锁不可用：{e}")))?;
    if !lock
        .metadata()
        .map_err(|e| Error::Config(format!("审批规则锁元数据不可用：{e}")))?
        .is_file()
    {
        return Err(Error::Config("审批规则锁必须是普通文件".into()));
    }
    lock.try_lock()
        .map_err(|e| Error::Config(format!("审批规则库无法独占，可能已被其他实例打开：{e}")))?;
    Ok(ApprovalLock { file: lock })
}

#[cfg(test)]
#[path = "../../../../../../test/agent/terminal/unit/store.rs"]
mod tests;
