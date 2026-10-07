use crate::{Error, ExecutionContext};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fmt,
    net::{IpAddr, SocketAddr},
    path::PathBuf,
    sync::Arc,
};

const MAX_RULES: usize = 256;
const MAX_POLICY_BYTES: usize = 1024 * 1024;

/// 目标连接的传输协议；HTTP、CONNECT 和 SOCKS TCP 都使用 TCP，协议与端口共同参与授权。
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalNetworkProtocol {
    /// 面向连接的字节流。
    Tcp,
    /// 独立数据报。
    Udp,
}

/// 规范化的目标地址；主机别名、大小写、IDNA 和 IPv4 映射地址不能绕过规则。
#[derive(Clone, Debug, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TerminalNetworkTarget {
    /// 规范化 DNS 名或 IP 字面量，不包含用户信息、路径或端口。
    pub host: String,
    /// 实际目标端口，必须大于零。
    pub port: u16,
    /// 实际连接的传输协议。
    pub protocol: TerminalNetworkProtocol,
}

impl TerminalNetworkTarget {
    /// 校验并规范化目标，不解析 DNS 或建立连接。
    /// # 错误
    /// 主机非法、包含控制字符或端口为零时返回配置错误。
    pub fn new(host: &str, port: u16, protocol: TerminalNetworkProtocol) -> Result<Self, Error> {
        if port == 0 {
            return Err(Error::Config("网络目标端口必须大于零".into()));
        }
        Ok(Self {
            host: normalize_host(host)?,
            port,
            protocol,
        })
    }
}

/// 静态目标规则；拒绝优先于允许，未匹配目标须经宿主审批才能访问。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalNetworkDecision {
    /// 在规则及私有地址边界内允许连接。
    Allow,
    /// 无条件拒绝匹配目标，不能由动态审批覆盖。
    Deny,
}

/// 对目标主机、协议和端口同时生效的宿主规则，不接受模型修改。
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TerminalNetworkRule {
    /// 精确主机、*.example.com（仅子域）、**.example.com（主域及子域）或 *。
    pub pattern: String,
    /// 允许匹配的协议；空列表代表所有传输协议。
    #[serde(default)]
    pub protocols: Vec<TerminalNetworkProtocol>,
    /// 允许匹配的目标端口；空列表代表所有端口。
    #[serde(default)]
    pub ports: Vec<u16>,
    /// 匹配时的允许或拒绝决定。
    pub decision: TerminalNetworkDecision,
}

/// 系统强制使用的目标网络策略；默认不开放任何目标或广泛的本机/私有网络访问。
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TerminalNetworkConfig {
    /// 各规则共同生效，不能通过排列顺序覆盖拒绝。
    #[serde(default)]
    pub rules: Vec<TerminalNetworkRule>,
    /// 是否允许 DNS 解析落入私有或保留地址；精确 localhost/IP 授权仍可限定单个本机目标。
    #[serde(default)]
    pub allow_private_network: bool,
    /// 宿主明确配置或从宿主环境采集的上游路由，不从模型命令环境动态读取。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream_proxy: Option<super::TerminalUpstreamProxy>,
    /// macOS 原生 Unix socket 路径规则；路径必须绝对且父目录存在，别名规范化后拒绝优先。
    /// 仅授权连接，不扩大普通文件读写范围；Linux 尚无路径代理时明确拒绝此配置。
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub unix_sockets: BTreeMap<PathBuf, TerminalNetworkDecision>,
    /// 宿主显式开放其他 Unix socket 目标；精确拒绝规则仍生效，默认关闭。
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub dangerously_allow_all_unix_sockets: bool,
    /// 是否开放 SOCKS5；关闭后 ALL_PROXY 改为 HTTP，UDP 入口也随之关闭。
    #[serde(default = "enabled", skip_serializing_if = "is_enabled")]
    pub enable_socks5: bool,
    /// 是否开放 SOCKS5 UDP；关闭后仍可使用 SOCKS5 TCP，不建立数据报关联。
    #[serde(default = "enabled", skip_serializing_if = "is_enabled")]
    pub enable_socks5_udp: bool,
    /// 宿主的共享 HTTP 入口；与进程私有代理独立，相同地址由进程凭据区分归属。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub http_listener: Option<TerminalProxyListener>,
    /// 宿主的共享 SOCKS5 入口；可与 HTTP 使用同一地址，UDP 与该 TCP 入口共用端口。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub socks_listener: Option<TerminalProxyListener>,
}

/// 宿主明确配置的代理监听范围；端口零由系统分配，默认只允许回环地址。
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TerminalProxyListener {
    /// 数字 IP 与端口，不在启动时解析域名或从命令环境推导监听范围。
    pub address: SocketAddr,
    /// 是否允许非回环或通配监听；默认关闭，不能由模型工具参数申请开启。
    #[serde(default)]
    pub allow_non_loopback: bool,
}

/// 已配置入口提供的应用层协议；相同地址可以同时承担两种协议。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalProxyProtocol {
    /// HTTP 请求与 CONNECT。
    Http,
    /// SOCKS5 TCP 与由宿主开关控制的 UDP。
    Socks5,
}

/// 宿主可读取的共享入口状态；不交付凭据、传输内容或其他会话的终端标识。
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TerminalProxyListenerInfo {
    /// 原始配置地址，端口可能为零。
    pub configured_address: SocketAddr,
    /// 实际占用的地址与端口。
    pub bound_address: SocketAddr,
    /// 此宿主工具在该地址配置的协议。
    pub protocols: Vec<TerminalProxyProtocol>,
    /// 此入口目前保留的有效进程凭据数量。
    pub active_terminals: usize,
}

impl Default for TerminalNetworkConfig {
    /// Rust 构造与 JSON 缺省字段采用同一默认值，保持既有 TCP/UDP 代理行为。
    fn default() -> Self {
        Self {
            rules: Vec::new(),
            allow_private_network: false,
            upstream_proxy: None,
            unix_sockets: BTreeMap::new(),
            dangerously_allow_all_unix_sockets: false,
            enable_socks5: enabled(),
            enable_socks5_udp: enabled(),
            http_listener: None,
            socks_listener: None,
        }
    }
}

fn enabled() -> bool {
    true
}
fn is_enabled(value: &bool) -> bool {
    *value
}

/// 已认证进程请求访问的新目标；同一会话中相同策略、主机、协议、端口的并发请求合并审批。
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TerminalNetworkApprovalRequest {
    /// 宿主会话身份，不能由模型选择。
    pub session_id: String,
    /// 发起目标请求的终端身份。
    pub terminal_id: String,
    /// 发起终端执行的工具调用标识。
    pub call_id: String,
    /// 发起终端的原始命令，仅用于关联上下文；审批范围是目标地址。
    pub command: String,
    /// 发起终端的绝对工作目录。
    pub workdir: PathBuf,
    /// 本次要连接的完整规范化目标。
    pub target: TerminalNetworkTarget,
}

/// 供宿主展示的实际网络尝试；不包含代理凭据、HTTP 标头或传输内容。
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TerminalNetworkObservation {
    /// 此事件归属的终端身份。
    pub terminal_id: String,
    /// 已通过格式校验的目标；传输或认证错误未确定目标时为 None。
    pub target: Option<TerminalNetworkTarget>,
    /// 是否已经建立经过规则校验的上游连接。
    pub connected: bool,
    /// 拒绝或传输失败的原因；成功时为 None。
    pub error: Option<String>,
}

/// 宿主对目标地址的决定；临时允许只覆盖当前审批组，会话许可在关闭会话时撤销。
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    tag = "decision",
    content = "details",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum TerminalNetworkApprovalDecision {
    /// 仅允许此刻等待同一目标的审批组。
    AllowOnce,
    /// 在相同策略的当前宿主会话中复用该目标许可。
    AllowForSession,
    /// 拒绝该目标并反馈宿主原因。
    Deny(String),
}

/// 宿主的目标审批边界；DNS 查询和实际连接均在目标获准之后发生。
#[async_trait]
pub trait TerminalNetworkApprover: Send + Sync + 'static {
    /// 返回对目标的明确决定；等待须遵守取消和截止时间，故障不会回退到自动允许。
    async fn approve(
        &self,
        request: TerminalNetworkApprovalRequest,
        context: ExecutionContext,
    ) -> Result<TerminalNetworkApprovalDecision, String>;
}

struct Inner {
    id: uuid::Uuid,
    config: TerminalNetworkConfig,
    unix: super::unix_policy::Policy,
    fingerprint: String,
    approver: Option<Arc<dyn TerminalNetworkApprover>>,
}

/// 不可变的目标策略及宿主审批入口；克隆保持同一策略身份，重新构造或更换审批入口会改变身份。
#[derive(Clone)]
pub struct TerminalNetworkPolicy(Arc<Inner>);

impl fmt::Debug for TerminalNetworkPolicy {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TerminalNetworkPolicy")
            .field("config", &self.0.config)
            .finish_non_exhaustive()
    }
}
impl PartialEq for TerminalNetworkPolicy {
    fn eq(&self, other: &Self) -> bool {
        self.0.id == other.0.id
    }
}
impl Eq for TerminalNetworkPolicy {}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct StoredConfig {
    version: u32,
    config: TerminalNetworkConfig,
}

impl TerminalNetworkPolicy {
    /// 验证并冻结规则，不绑定端口或启动任务。
    /// # 错误
    /// 主机、端口或 Unix 路径非法、规则超预算、配置超过 1 MiB 或平台不支持时拒绝整份配置。
    pub fn new(mut config: TerminalNetworkConfig) -> Result<Self, Error> {
        for listener in [&mut config.http_listener, &mut config.socks_listener]
            .into_iter()
            .flatten()
        {
            let ip = listener.address.ip().to_canonical();
            listener.address.set_ip(ip);
            if ip.is_multicast()
                || ip == IpAddr::V4(std::net::Ipv4Addr::BROADCAST)
                || (!ip.is_loopback() && !listener.allow_non_loopback)
            {
                return Err(Error::Config(
                    "代理监听地址无效，非回环或通配地址必须由宿主显式开放".into(),
                ));
            }
        }
        let unix = super::unix_policy::validate(&config)?;
        if let Some(proxy) = &mut config.upstream_proxy {
            proxy.validate()?;
        }
        if config.rules.len() > MAX_RULES {
            return Err(Error::Config("网络规则超过 256 项上限".into()));
        }
        for rule in &mut config.rules {
            rule.pattern = normalize_pattern(&rule.pattern)?;
            if rule.protocols.len() > 2 || rule.ports.len() > 64 || rule.ports.contains(&0) {
                return Err(Error::Config("网络规则协议或端口列表无效".into()));
            }
            rule.protocols.sort_unstable();
            rule.protocols.dedup();
            rule.ports.sort_unstable();
            rule.ports.dedup();
        }
        let bytes = serde_json::to_vec(&config)
            .map_err(|error| Error::Config(format!("网络配置编码失败：{error}")))?;
        if bytes.len() > MAX_POLICY_BYTES {
            return Err(Error::Config("网络配置超过 1 MiB 预算".into()));
        }
        let mut hash = super::super::fingerprint::Fingerprint::new("noemori-network-policy-v1");
        hash.bytes(&bytes);
        if !unix.rules.is_empty() {
            hash.bytes(
                &serde_json::to_vec(&unix)
                    .map_err(|error| Error::Config(format!("Unix 授权编码失败：{error}")))?,
            );
        }
        Ok(Self(Arc::new(Inner {
            id: uuid::Uuid::new_v4(),
            config,
            unix,
            fingerprint: hash.finish(),
            approver: None,
        })))
    }

    /// 安装宿主审批入口；已有静态拒绝规则仍优先于宿主的动态允许。
    pub fn with_approver(self, approver: Arc<dyn TerminalNetworkApprover>) -> Self {
        Self(Arc::new(Inner {
            id: uuid::Uuid::new_v4(),
            config: self.0.config.clone(),
            unix: self.0.unix.clone(),
            fingerprint: self.0.fingerprint.clone(),
            approver: Some(approver),
        }))
    }

    /// 读取严格版本化 JSON，供宿主加载受信配置；模型不能指定文件或动态重载。
    /// # 错误
    /// 内容超预算、版本不支持、未知字段或规则无效时返回配置错误。
    pub fn from_json(bytes: &[u8]) -> Result<Self, Error> {
        if bytes.len() > MAX_POLICY_BYTES {
            return Err(Error::Config("网络配置超过 1 MiB 预算".into()));
        }
        let stored: StoredConfig = serde_json::from_slice(bytes)
            .map_err(|error| Error::Config(format!("网络配置 JSON 无效：{error}")))?;
        if stored.version != 1 {
            return Err(Error::Config("网络配置版本不支持".into()));
        }
        Self::new(stored.config)
    }

    /// 导出供宿主保存的配置，不包含审批处理器或运行身份。
    /// # 错误
    /// JSON 编码失败时返回配置错误。
    pub fn to_json(&self) -> Result<String, Error> {
        serde_json::to_string(&StoredConfig {
            version: 1,
            config: self.0.config.clone(),
        })
        .map_err(|error| Error::Config(format!("网络配置编码失败：{error}")))
    }

    /// 返回已验证的只读配置，供宿主展示规则。
    pub fn config(&self) -> &TerminalNetworkConfig {
        &self.0.config
    }

    #[cfg(target_os = "macos")]
    pub(in crate::tool::terminal) fn unix(&self) -> &super::unix_policy::Policy {
        &self.0.unix
    }

    /// 无副作用地检查目标规则，不解析 DNS、请求审批或建立连接。
    /// # 错误
    /// 外部构造的目标无效时返回配置错误。
    pub fn decision(
        &self,
        target: &TerminalNetworkTarget,
    ) -> Result<Option<TerminalNetworkDecision>, Error> {
        let target = TerminalNetworkTarget::new(&target.host, target.port, target.protocol)?;
        let mut allowed = false;
        for rule in &self.0.config.rules {
            if matches_rule(rule, &target) {
                if rule.decision == TerminalNetworkDecision::Deny {
                    return Ok(Some(TerminalNetworkDecision::Deny));
                }
                allowed = true;
            }
        }
        Ok(allowed.then_some(TerminalNetworkDecision::Allow))
    }

    pub(super) fn id(&self) -> uuid::Uuid {
        self.0.id
    }
    pub(in crate::tool::terminal) fn fingerprint(&self) -> &str {
        &self.0.fingerprint
    }
    pub(super) fn approver(&self) -> Option<&Arc<dyn TerminalNetworkApprover>> {
        self.0.approver.as_ref()
    }
    pub(super) fn permits_private(&self, target: &TerminalNetworkTarget, approved: bool) -> bool {
        self.0.config.allow_private_network
            || (is_local_literal(&target.host)
                && (approved
                    || self.0.config.rules.iter().any(|rule| {
                        rule.decision == TerminalNetworkDecision::Allow
                            && rule.pattern == target.host
                            && matches_rule(rule, target)
                    })))
    }
}

fn matches_rule(rule: &TerminalNetworkRule, target: &TerminalNetworkTarget) -> bool {
    (rule.protocols.is_empty() || rule.protocols.contains(&target.protocol))
        && (rule.ports.is_empty() || rule.ports.contains(&target.port))
        && match rule.pattern.as_str() {
            "*" => true,
            pattern if pattern.starts_with("**.") => {
                target.host == pattern[3..] || target.host.ends_with(&pattern[2..])
            }
            pattern if pattern.starts_with("*.") => target.host.ends_with(&pattern[1..]),
            pattern => target.host == pattern,
        }
}

fn normalize_pattern(pattern: &str) -> Result<String, Error> {
    if pattern == "*" {
        return Ok(pattern.into());
    }
    for prefix in ["**.", "*."] {
        if let Some(host) = pattern.strip_prefix(prefix) {
            let host = normalize_host(host)?;
            if host.parse::<IpAddr>().is_ok() {
                return Err(Error::Config("网络通配规则不能使用 IP 字面量".into()));
            }
            return Ok(format!("{prefix}{host}"));
        }
    }
    normalize_host(pattern)
}

pub(super) fn normalize_host(host: &str) -> Result<String, Error> {
    if host.is_empty()
        || host
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
        || host.contains(['@', '/', '\\', '*', '%'])
    {
        return Err(Error::Config("网络主机格式无效".into()));
    }
    let text = host
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(host);
    if let Ok(address) = text.parse::<IpAddr>() {
        return Ok(match address {
            IpAddr::V6(address) => address
                .to_ipv4_mapped()
                .map_or_else(|| address.to_string(), |address| address.to_string()),
            address => address.to_string(),
        });
    }
    match url::Host::parse(host).map_err(|error| Error::Config(format!("网络主机无效：{error}")))?
    {
        url::Host::Ipv4(address) => Ok(address.to_string()),
        url::Host::Ipv6(address) => Ok(address.to_string()),
        url::Host::Domain(host) => {
            let host = host.strip_suffix('.').unwrap_or(&host).to_lowercase();
            if host.len() > 253
                || host.split('.').any(|label| {
                    label.is_empty()
                        || label.len() > 63
                        || label.starts_with('-')
                        || label.ends_with('-')
                        || !label
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                })
            {
                return Err(Error::Config("网络 DNS 主机格式无效".into()));
            }
            Ok(host)
        }
    }
}

fn is_local_literal(host: &str) -> bool {
    host == "localhost"
        || host
            .parse::<IpAddr>()
            .is_ok_and(|address| !public_address(address))
}

pub(super) fn public_address(address: IpAddr) -> bool {
    use ipnet::IpNet;
    use std::sync::LazyLock;
    static RESERVED: LazyLock<Vec<IpNet>> = LazyLock::new(|| {
        [
            "0.0.0.0/8",
            "10.0.0.0/8",
            "100.64.0.0/10",
            "127.0.0.0/8",
            "169.254.0.0/16",
            "172.16.0.0/12",
            "192.0.0.0/24",
            "192.0.2.0/24",
            "192.168.0.0/16",
            "198.18.0.0/15",
            "198.51.100.0/24",
            "203.0.113.0/24",
            "224.0.0.0/4",
            "240.0.0.0/4",
            "::/96",
            "::ffff:0:0/96",
            "64:ff9b:1::/48",
            "100::/64",
            "2001:db8::/32",
            "fc00::/7",
            "fe80::/10",
            "ff00::/8",
        ]
        .into_iter()
        .map(|text| text.parse().expect("固定的保留地址网段必须有效"))
        .collect()
    });
    if let IpAddr::V6(address) = address {
        if let Some(address) = address.to_ipv4_mapped() {
            return public_address(IpAddr::V4(address));
        }
        if address.segments()[..6] == [0x64, 0xff9b, 0, 0, 0, 0] {
            return public_address(IpAddr::V4(std::net::Ipv4Addr::new(
                address.octets()[12],
                address.octets()[13],
                address.octets()[14],
                address.octets()[15],
            )));
        }
    }
    !RESERVED.iter().any(|range| range.contains(&address))
}
