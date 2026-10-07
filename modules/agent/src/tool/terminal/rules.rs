mod command;
mod session;
mod store;

use super::{TerminalApprovalRequest, TerminalPermissionRequest};
pub(super) use command::literal_command;
use serde::{Deserialize, Serialize};
pub(crate) use session::SessionApprovals;
use std::path::PathBuf;
pub use store::TerminalApprovalStore;

const MAX_RULES: usize = 256;
const MAX_STORE_BYTES: usize = 1024 * 1024;

/// 固定的执行上下文；规则不能从一个目录、shell 或环境自动迁移到另一个上下文。
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TerminalApprovalScope {
    /// 原始宿主授权的指纹，不包含环境变量明文。
    pub policy_fingerprint: String,
    /// 初始化快照的稳定指纹；None 表示未使用初始化快照。
    pub environment_fingerprint: Option<String>,
    /// 已解析的实际工作目录。
    pub workdir: PathBuf,
    /// 宿主选择的 shell 可执行文件。
    pub shell: PathBuf,
    /// 是否采用登录环境。
    pub login: bool,
    /// 是否允许 PTY 交互。
    pub tty: bool,
    /// 是否打开非 PTY 输入。
    pub stdin: bool,
}

impl TerminalApprovalScope {
    pub(super) fn from_request(request: &TerminalApprovalRequest) -> Self {
        Self {
            policy_fingerprint: request.policy_fingerprint.clone(),
            environment_fingerprint: request.environment_fingerprint.clone(),
            workdir: request.workdir.clone(),
            shell: request.shell.clone(),
            login: request.login,
            tty: request.tty,
            stdin: request.stdin,
        }
    }
}

/// 一次已批准的读取范围；文件授权不会因路径后来变成目录而升级为递归读取。
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TerminalReadGrant {
    /// 已解析的绝对路径。
    pub path: PathBuf,
    /// 批准时是否为目录；false 只匹配该文件本身。
    pub recursive: bool,
}

/// 资源许可只可复用于自身或更小范围，读取许可不会自动变成写入许可。
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TerminalPermissionGrant {
    /// 文件或目录读取范围。
    pub readable: Vec<TerminalReadGrant>,
    /// 已存在的可读写目录。
    pub writable: Vec<PathBuf>,
    /// 是否明确批准联网，false 不能匹配请求联网的调用。
    pub network: bool,
}

impl TerminalPermissionGrant {
    pub(super) fn from_request(request: &TerminalPermissionRequest) -> Result<Self, String> {
        let readable = request
            .readable_paths
            .iter()
            .map(|path| {
                let metadata = path
                    .metadata()
                    .map_err(|e| format!("授权对象无法读取：{e}"))?;
                Ok(TerminalReadGrant {
                    path: path.clone(),
                    recursive: metadata.is_dir(),
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        Ok(Self {
            readable,
            writable: request.writable_paths.clone(),
            network: request.network,
        })
    }

    fn contains(&self, requested: &Self) -> bool {
        (!requested.network || self.network)
            && requested
                .writable
                .iter()
                .all(|path| self.writable.iter().any(|root| path.starts_with(root)))
            && requested.readable.iter().all(|grant| {
                self.writable
                    .iter()
                    .any(|root| grant.path.starts_with(root))
                    || self.readable.iter().any(|root| {
                        if root.recursive {
                            grant.path.starts_with(&root.path)
                        } else {
                            !grant.recursive && grant.path == root.path
                        }
                    })
            })
    }
}

/// 宿主明确保存的前缀授权；多个命令、展开表达式和重定向始终需要新的完整审批。
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TerminalApprovalRule {
    /// 由宿主生成的撤销定位标识，模型不能选择。
    pub id: String,
    /// 单个字面命令的参数前缀。
    pub prefix: Vec<String>,
    /// 该授权适用的执行上下文。
    pub scope: TerminalApprovalScope,
    /// 被批准的资源上限。
    pub permissions: TerminalPermissionGrant,
    /// 单命令最长寿命；None 表示原审批未设置时限，不限制后续更短的寿命。
    pub max_timeout_ms: Option<u64>,
}

impl TerminalApprovalRule {
    pub(super) fn new(
        prefix: Vec<String>,
        request: &TerminalApprovalRequest,
        permissions: TerminalPermissionGrant,
    ) -> Result<Self, String> {
        validate_prefix(&prefix)?;
        let words = literal_command(&request.command)
            .ok_or("只有不含展开、重定向或多个命令的字面调用才能保存前缀规则")?;
        if !words.starts_with(&prefix) {
            return Err("宿主给出的前缀与实际命令不一致，未保存或执行".into());
        }
        Ok(Self {
            id: uuid::Uuid::new_v4().to_string(),
            prefix,
            scope: TerminalApprovalScope::from_request(request),
            permissions,
            max_timeout_ms: request.timeout_ms,
        })
    }

    fn matches(
        &self,
        request: &TerminalApprovalRequest,
        permissions: &TerminalPermissionGrant,
    ) -> bool {
        self.scope == TerminalApprovalScope::from_request(request)
            && self.permissions.contains(permissions)
            && match (self.max_timeout_ms, request.timeout_ms) {
                (None, _) => true,
                (Some(max), Some(timeout)) => timeout <= max,
                _ => false,
            }
            && literal_command(&request.command)
                .is_some_and(|words| words.starts_with(&self.prefix))
    }

    fn validate(&self) -> Result<(), String> {
        uuid::Uuid::parse_str(&self.id).map_err(|_| "审批规则标识无效")?;
        validate_prefix(&self.prefix)?;
        if !self.scope.workdir.is_absolute() || !self.scope.shell.is_absolute() {
            return Err("审批规则目录和 shell 必须是绝对路径".into());
        }
        if !valid_fingerprint(&self.scope.policy_fingerprint)
            || self
                .scope
                .environment_fingerprint
                .as_ref()
                .is_some_and(|value| !valid_fingerprint(value))
        {
            return Err("审批规则的权限或环境指纹无效".into());
        }
        if self.permissions.readable.len() + self.permissions.writable.len() > 64
            || self
                .permissions
                .readable
                .iter()
                .any(|grant| !grant.path.is_absolute())
            || self
                .permissions
                .writable
                .iter()
                .any(|path| !path.is_absolute())
        {
            return Err("审批规则资源路径无效或超过数量上限".into());
        }
        if self
            .max_timeout_ms
            .is_some_and(|timeout| timeout == 0 || timeout > 86_400_000)
        {
            return Err("审批规则执行时限无效".into());
        }
        Ok(())
    }
}

fn valid_fingerprint(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn validate_prefix(prefix: &[String]) -> Result<(), String> {
    if prefix.is_empty()
        || prefix.len() > 32
        || prefix
            .iter()
            .any(|word| word.is_empty() || word.contains('\0') || word.len() > 8192)
    {
        return Err("审批前缀须为 1..32 个非空字面参数，每个不超过 8192 字节".into());
    }
    Ok(())
}

#[cfg(test)]
#[path = "../../../../../test/agent/terminal/unit/rules.rs"]
mod tests;
