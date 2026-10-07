use crate::Error;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use std::{fmt, net::SocketAddr, sync::Arc};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufStream};

/// 宿主冻结的上游路由；原目标仍须通过本地规则与地址检查，上游地址不能由模型修改。
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TerminalUpstreamProxy {
    url: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    trusted_roots: Vec<Vec<u8>>,
}

impl fmt::Debug for TerminalUpstreamProxy {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let value = url::Url::parse(&self.url)
            .map(|url| {
                format!(
                    "{}://{}:{}",
                    url.scheme(),
                    url.host_str().unwrap_or(""),
                    url.port_or_known_default().unwrap_or(1080)
                )
            })
            .unwrap_or_else(|_| "无效上游".into());
        f.debug_struct("TerminalUpstreamProxy")
            .field("endpoint", &value)
            .finish_non_exhaustive()
    }
}

impl TerminalUpstreamProxy {
    /// 验证 HTTP/HTTPS/SOCKS5 代理 URL；仅保存路由，不建立连接。
    /// # 错误
    /// 地址、端口、凭据、路径、查询或片段非法时返回配置错误。
    pub fn new(url: &str) -> Result<Self, Error> {
        let mut proxy = Self {
            url: url.into(),
            trusted_roots: Vec::new(),
        };
        proxy.validate()?;
        Ok(proxy)
    }

    /// 增加宿主明确提供的 DER 根证书，用于企业 HTTPS 代理；不会关闭主机名、签名或证书链验证。
    /// # 错误
    /// 根证书超过 16 项、单项超过 64 KiB 或 DER 无效时返回配置错误。
    pub fn with_trusted_roots(mut self, roots: Vec<Vec<u8>>) -> Result<Self, Error> {
        self.trusted_roots = roots;
        self.validate()?;
        Ok(self)
    }

    /// 采集宿主的 ALL_PROXY、HTTPS_PROXY 或 HTTP_PROXY，后续不再读取命令环境中的同名变量。
    /// # 错误
    /// 已设置的代理 URL 非 UTF-8 或无效时拒绝配置，不回退为直接连接。
    pub fn from_environment() -> Result<Option<Self>, Error> {
        for name in [
            "ALL_PROXY",
            "all_proxy",
            "HTTPS_PROXY",
            "https_proxy",
            "HTTP_PROXY",
            "http_proxy",
        ] {
            if let Some(value) = std::env::var_os(name)
                && !value.is_empty()
            {
                return Self::new(
                    value
                        .to_str()
                        .ok_or_else(|| Error::Config("宿主上游代理 URL 必须为 UTF-8".into()))?,
                )
                .map(Some);
            }
        }
        Ok(None)
    }

    pub(super) fn validate(&mut self) -> Result<(), Error> {
        if self.trusted_roots.len() > 16 || self.trusted_roots.iter().any(|root| root.len() > 65536)
        {
            return Err(Error::Config("上游 HTTPS 根证书超出预算".into()));
        }
        let mut store = tokio_rustls::rustls::RootCertStore::empty();
        for root in &self.trusted_roots {
            store
                .add(tokio_rustls::rustls::pki_types::CertificateDer::from(
                    root.clone(),
                ))
                .map_err(|_| Error::Config("上游 HTTPS 根证书 DER 无效".into()))?;
        }
        let parsed = self.parsed()?;
        self.url = parsed.url.to_string();
        Ok(())
    }
    fn parsed(&self) -> Result<Parsed, Error> {
        if self.url.len() > 8192 {
            return Err(Error::Config("上游代理 URL 超出 8 KiB 预算".into()));
        }
        let url = url::Url::parse(&self.url)
            .map_err(|_| Error::Config("上游代理 URL 格式无效".into()))?;
        let kind = match url.scheme() {
            "http" => Kind::Http,
            "https" => Kind::Https,
            "socks5" | "socks5h" => Kind::Socks,
            _ => return Err(Error::Config("上游代理须使用 HTTP、HTTPS 或 SOCKS5".into())),
        };
        if !matches!(url.path(), "" | "/") || url.query().is_some() || url.fragment().is_some() {
            return Err(Error::Config(
                "上游代理 URL 不能包含业务路径、查询或片段".into(),
            ));
        }
        let host = super::policy::normalize_host(
            url.host_str()
                .ok_or_else(|| Error::Config("上游代理缺少主机".into()))?,
        )?;
        let port = url.port_or_known_default().unwrap_or(1080);
        if port == 0 {
            return Err(Error::Config("上游代理端口不能为零".into()));
        }
        let credentials = if !url.username().is_empty() || url.password().is_some() {
            let username = percent_encoding::percent_decode_str(url.username())
                .decode_utf8()
                .map_err(|_| Error::Config("上游用户名编码无效".into()))?
                .into_owned();
            let password = percent_encoding::percent_decode_str(url.password().unwrap_or(""))
                .decode_utf8()
                .map_err(|_| Error::Config("上游密码编码无效".into()))?
                .into_owned();
            let limit = if kind == Kind::Socks { 255 } else { 2048 };
            if username.len() > limit
                || password.len() > limit
                || username.contains(['\0', '\r', '\n'])
                || password.contains(['\0', '\r', '\n'])
                || (kind == Kind::Socks && (username.is_empty() || password.is_empty()))
            {
                return Err(Error::Config("上游代理凭据无效或超出协议预算".into()));
            }
            Some(Credentials { username, password })
        } else {
            None
        };
        Ok(Parsed {
            url,
            kind,
            host,
            port,
            credentials,
            trusted_roots: self.trusted_roots.clone(),
        })
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Http,
    Https,
    Socks,
}
struct Credentials {
    username: String,
    password: String,
}
struct Parsed {
    url: url::Url,
    kind: Kind,
    host: String,
    port: u16,
    credentials: Option<Credentials>,
    trusted_roots: Vec<Vec<u8>>,
}

/// TLS 上游和明文上游具有同一字节流契约，调用者不能把 TLS 通道强制转换为 TCP 句柄。
pub(super) trait ProxyIo: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> ProxyIo for T {}
pub(super) type Stream = Box<dyn ProxyIo>;

pub(super) async fn connect(
    proxy: &TerminalUpstreamProxy,
    addresses: &[SocketAddr],
) -> Result<Stream, String> {
    let parsed = proxy.parsed().map_err(|error| error.to_string())?;
    let mut last_error = None;
    for address in addresses {
        match connect_one(&parsed, *address).await {
            Ok(stream) => return Ok(stream),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| "上游代理没有可连接的目标地址".into()))
}

async fn connect_one(proxy: &Parsed, target: SocketAddr) -> Result<Stream, String> {
    let tcp = tokio::net::TcpStream::connect((proxy.host.as_str(), proxy.port))
        .await
        .map_err(|error| format!("上游代理连接失败：{error}"))?;
    let stream: Stream = if proxy.kind == Kind::Https {
        let provider = tokio_rustls::rustls::crypto::aws_lc_rs::default_provider();
        let provider = Arc::new(provider);
        let verifier = rustls_platform_verifier::Verifier::new_with_extra_roots(
            proxy
                .trusted_roots
                .iter()
                .cloned()
                .map(tokio_rustls::rustls::pki_types::CertificateDer::from),
            provider.clone(),
        )
        .map_err(|error| error.to_string())?;
        let config = tokio_rustls::rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .map_err(|error| error.to_string())?
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(verifier))
            .with_no_client_auth();
        let name = tokio_rustls::rustls::pki_types::ServerName::try_from(proxy.host.clone())
            .map_err(|error| error.to_string())?;
        Box::new(
            tokio_rustls::TlsConnector::from(Arc::new(config))
                .connect(name, tcp)
                .await
                .map_err(|error| format!("上游代理 TLS 验证失败：{error}"))?,
        )
    } else {
        Box::new(tcp)
    };
    match proxy.kind {
        Kind::Http | Kind::Https => http_connect(stream, target, proxy.credentials.as_ref()).await,
        Kind::Socks => socks_connect(stream, target, proxy.credentials.as_ref()).await,
    }
}

async fn http_connect(
    stream: Stream,
    target: SocketAddr,
    credentials: Option<&Credentials>,
) -> Result<Stream, String> {
    let mut stream = BufStream::new(stream);
    let mut request = format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n");
    if let Some(credentials) = credentials {
        request.push_str(&format!(
            "Proxy-Authorization: Basic {}\r\n",
            STANDARD.encode(format!("{}:{}", credentials.username, credentials.password))
        ));
    }
    request.push_str("\r\n");
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|error| error.to_string())?;
    stream.flush().await.map_err(|error| error.to_string())?;
    let mut header = Vec::new();
    loop {
        let available = stream.fill_buf().await.map_err(|error| error.to_string())?;
        if available.is_empty() {
            return Err("上游 CONNECT 在完整响应前结束".into());
        }
        let count = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |index| index + 1);
        if header.len() + count > 32768 {
            return Err("上游 CONNECT 响应标头超过预算".into());
        }
        header.extend(&available[..count]);
        stream.consume(count);
        let mut fields = [httparse::EMPTY_HEADER; 128];
        let mut response = httparse::Response::new(&mut fields);
        match response
            .parse(&header)
            .map_err(|_| "上游 CONNECT 响应无效")?
        {
            httparse::Status::Partial => {}
            httparse::Status::Complete(_) => {
                if response.code.is_some_and(|code| (200..300).contains(&code)) {
                    return Ok(Box::new(stream));
                }
                return Err(format!(
                    "上游代理拒绝 CONNECT，状态码 {}",
                    response.code.unwrap_or(0)
                ));
            }
        }
    }
}

async fn socks_connect(
    mut stream: Stream,
    target: SocketAddr,
    credentials: Option<&Credentials>,
) -> Result<Stream, String> {
    socks_authenticate(&mut stream, credentials).await?;
    socks_command(&mut stream, 1, target).await?;
    Ok(stream)
}

async fn socks_authenticate(
    stream: &mut Stream,
    credentials: Option<&Credentials>,
) -> Result<(), String> {
    let method = u8::from(credentials.is_some()) * 2;
    stream
        .write_all(&[5, 1, method])
        .await
        .map_err(|error| error.to_string())?;
    let mut reply = [0; 2];
    stream
        .read_exact(&mut reply)
        .await
        .map_err(|error| error.to_string())?;
    if reply != [5, method] {
        return Err("上游 SOCKS5 不接受所需认证方式".into());
    }
    if let Some(credentials) = credentials {
        let mut auth = vec![
            1,
            u8::try_from(credentials.username.len()).map_err(|error| error.to_string())?,
        ];
        auth.extend(credentials.username.as_bytes());
        auth.push(u8::try_from(credentials.password.len()).map_err(|error| error.to_string())?);
        auth.extend(credentials.password.as_bytes());
        stream
            .write_all(&auth)
            .await
            .map_err(|error| error.to_string())?;
        stream
            .read_exact(&mut reply)
            .await
            .map_err(|error| error.to_string())?;
        if reply != [1, 0] {
            return Err("上游 SOCKS5 拒绝认证".into());
        }
    }
    Ok(())
}

/// 上游返回的绑定位置；UDP 必须解析并固定中继，CONNECT 只消费该字段。
pub(super) enum BoundAddress {
    Ip(SocketAddr),
    Host(String, u16),
}

pub(super) async fn socks_command(
    stream: &mut Stream,
    command: u8,
    target: SocketAddr,
) -> Result<BoundAddress, String> {
    let mut request = vec![5, command, 0];
    match target.ip() {
        std::net::IpAddr::V4(ip) => {
            request.push(1);
            request.extend(ip.octets());
        }
        std::net::IpAddr::V6(ip) => {
            request.push(4);
            request.extend(ip.octets());
        }
    }
    request.extend(target.port().to_be_bytes());
    stream
        .write_all(&request)
        .await
        .map_err(|error| error.to_string())?;
    let mut header = [0; 4];
    stream
        .read_exact(&mut header)
        .await
        .map_err(|error| error.to_string())?;
    if header[..3] != [5, 0, 0] {
        return Err(format!("上游 SOCKS5 拒绝目标，状态码 {}", header[1]));
    }
    let host = match header[3] {
        1 => {
            let mut bytes = [0; 4];
            stream
                .read_exact(&mut bytes)
                .await
                .map_err(|error| error.to_string())?;
            std::net::Ipv4Addr::from(bytes).to_string()
        }
        4 => {
            let mut bytes = [0; 16];
            stream
                .read_exact(&mut bytes)
                .await
                .map_err(|error| error.to_string())?;
            std::net::Ipv6Addr::from(bytes).to_string()
        }
        3 => {
            let size = usize::from(stream.read_u8().await.map_err(|error| error.to_string())?);
            if size == 0 {
                return Err("上游 SOCKS5 返回空主机名".into());
            }
            let mut bytes = vec![0; size];
            stream
                .read_exact(&mut bytes)
                .await
                .map_err(|error| error.to_string())?;
            let host = std::str::from_utf8(&bytes).map_err(|error| error.to_string())?;
            super::policy::normalize_host(host).map_err(|error| error.to_string())?
        }
        _ => return Err("上游 SOCKS5 返回无效地址类型".into()),
    };
    let port = stream.read_u16().await.map_err(|error| error.to_string())?;
    Ok(match host.parse() {
        Ok(ip) => BoundAddress::Ip(SocketAddr::new(ip, port)),
        Err(_) => BoundAddress::Host(host, port),
    })
}

pub(super) async fn connect_datagram(
    proxy: &TerminalUpstreamProxy,
    target: SocketAddr,
) -> Result<super::upstream_udp::Datagrams, String> {
    let parsed = proxy.parsed().map_err(|error| error.to_string())?;
    if parsed.kind != Kind::Socks {
        return Err("HTTP/HTTPS 上游不支持 UDP，禁止回退为直连".into());
    }
    let tcp = tokio::net::TcpStream::connect((parsed.host.as_str(), parsed.port))
        .await
        .map_err(|error| format!("上游代理连接失败：{error}"))?;
    let peer = tcp.peer_addr().map_err(|error| error.to_string())?;
    let mut stream: Stream = Box::new(tcp);
    socks_authenticate(&mut stream, parsed.credentials.as_ref()).await?;
    super::upstream_udp::Datagrams::connect(stream, peer, target).await
}

#[cfg(test)]
#[path = "../../../../../../test/agent/terminal/unit/upstream.rs"]
mod tests;
