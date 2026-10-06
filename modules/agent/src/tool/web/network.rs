//! 搜索、PDF 下载与浏览器使用同一代理来源；每次跳转重新检查公开 URL。

use super::WebLimits;
use crate::ExecutionContext;
use base64::{Engine, engine::general_purpose::STANDARD};
use encoding_rs::Encoding;
use hyper_util::client::proxy::matcher::Matcher;
use reqwest::{Client, Url};
use serde::Serialize;
use std::net::IpAddr;

/// 系统代理的最小运行配置，认证只传给网络出口，不进入模型观察。
#[derive(Serialize)]
pub(super) struct BrowserProxy {
    server: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    password: Option<String>,
}

/// 按目标 `url` 匹配系统代理和绕过规则，返回可供下载及浏览器共用的配置。
/// 无匹配代理时返回 `None`；地址或认证编码无效时返回不含凭据的错误。
pub(super) fn proxy_for(url: &str) -> Result<Option<BrowserProxy>, String> {
    let uri = url
        .parse::<http::Uri>()
        .map_err(|_| "URL 不能转换为 HTTP 地址")?;
    Matcher::from_system()
        .intercept(&uri)
        .map(|proxy| {
            let auth = if let Some((user, password)) = proxy.raw_auth() {
                Some((user.to_owned(), password.to_owned()))
            } else if let Some(header) = proxy.basic_auth() {
                let encoded = header
                    .to_str()
                    .ok()
                    .and_then(|value| value.strip_prefix("Basic "))
                    .ok_or("系统代理 Basic 认证格式无效")?;
                let bytes = STANDARD
                    .decode(encoded)
                    .map_err(|_| "系统代理 Basic 认证编码无效")?;
                let value = String::from_utf8(bytes).map_err(|_| "系统代理认证不是 UTF-8")?;
                let (user, password) = value.split_once(':').ok_or("系统代理认证缺少密码字段")?;
                Some((user.to_owned(), password.to_owned()))
            } else {
                None
            };
            Ok(BrowserProxy {
                server: proxy.uri().to_string(),
                username: auth.as_ref().map(|pair| pair.0.clone()),
                password: auth.map(|pair| pair.1),
            })
        })
        .transpose()
}

/// 已完成公开地址和字节预算检查的响应；已识别的验证页必须交给浏览器核验。
pub(super) struct Download {
    pub url: String,
    pub bytes: Vec<u8>,
    pub content_type: String,
    /// 已识别的浏览器验证需要升级到原浏览器链路，不能作为普通响应提交。
    pub requires_browser: bool,
}

impl Download {
    /// 按响应字符集、HTML 元数据或 BOM 解码正文，未声明编码时使用 UTF-8。
    /// 返回完整解码文本；未知字符集或非法字节必须报错，不能以替代字符掩盖损坏。
    pub fn text(&self) -> Result<String, String> {
        let label = self
            .content_type
            .split(';')
            .find_map(|part| part.trim().strip_prefix("charset="))
            .map(|label| label.trim_matches(['\'', '"']).to_owned());
        let meta = if label.is_none() && self.content_type.contains("html") {
            let prefix = String::from_utf8_lossy(&self.bytes[..self.bytes.len().min(4096)]);
            let document = scraper::Html::parse_document(&prefix);
            let selector = scraper::Selector::parse("meta[charset]").expect("固定选择器有效");
            document
                .select(&selector)
                .next()
                .and_then(|node| node.value().attr("charset"))
                .map(str::to_owned)
        } else {
            None
        };
        let encoding = match label.or(meta) {
            Some(label) => Encoding::for_label(label.as_bytes())
                .ok_or_else(|| format!("不支持网页字符编码 {label}"))?,
            None => Encoding::for_bom(&self.bytes)
                .map(|value| value.0)
                .unwrap_or(encoding_rs::UTF_8),
        };
        let (text, _, invalid) = encoding.decode(&self.bytes);
        if invalid {
            return Err("网页包含无法按声明编码解码的字节".into());
        }
        Ok(text.into_owned())
    }
}

fn public_address(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !(ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_multicast()
                || ip.is_unspecified()
                || ip.is_broadcast()
                || a == 0
                || a >= 240
                || (a == 100 && (64..=127).contains(&b))
                || (a == 192 && b == 0 && c <= 2)
                || (a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100)))
                || (a == 203 && b == 0 && c == 113))
        }
        IpAddr::V6(ip) => ip
            .to_ipv4_mapped()
            .map(|ip| public_address(IpAddr::V4(ip)))
            .unwrap_or(
                (0x2000..=0x3fff).contains(&ip.segments()[0])
                    && ip.segments()[..2] != [0x2001, 0x0db8],
            ),
    }
}

async fn checked_client(
    url: &Url,
    context: &ExecutionContext,
    limits: &WebLimits,
) -> Result<Client, String> {
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("仅允许无认证信息的公开 HTTP(S) URL".into());
    }
    let host = url.host_str().ok_or("URL 缺少主机")?;
    // URL 的 IPv6 主机带方括号，系统解析器接收的是不带括号的地址。
    let dns_host = host.trim_matches(['[', ']']);
    let addresses = context
        .wait(tokio::net::lookup_host((
            dns_host,
            url.port_or_known_default().ok_or("URL 端口无效")?,
        )))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| format!("DNS 解析失败：{error}"))?
        .collect::<Vec<_>>();
    if addresses.is_empty()
        || addresses
            .iter()
            .any(|address| !public_address(address.ip()))
    {
        return Err("URL 指向本地、内网或非公开地址，Web 工具只读取公开资料".into());
    }
    // 地址检查与实际连接绑定，避免直连路径在检查后重新解析成其他目标。
    let mut builder = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .resolve_to_addrs(host, &addresses)
        .user_agent("Noemori-Web/0.1")
        .timeout(limits.timeout);
    if let Some(proxy) = proxy_for(url.as_str())? {
        let mut configured = reqwest::Proxy::all(&proxy.server).map_err(|_| "系统代理配置无效")?;
        if let (Some(user), Some(password)) = (proxy.username, proxy.password) {
            configured = configured.basic_auth(&user, &password);
        }
        builder = builder.proxy(configured);
    }
    builder
        .build()
        .map_err(|error| format!("Web 网络初始化失败：{error}"))
}

async fn read_response(
    mut response: reqwest::Response,
    url: &Url,
    context: &ExecutionContext,
    limits: &WebLimits,
) -> Result<Download, String> {
    let status = response.status();
    let mitigated = response
        .headers()
        .get("cf-mitigated")
        .is_some_and(|value| value == "challenge");
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_owned();
    let html =
        content_type.starts_with("text/html") || content_type.starts_with("application/xhtml+xml");
    if !status.is_success() && (!matches!(status.as_u16(), 403 | 503) || !(html || mitigated)) {
        return Err(status_error(status.as_u16()));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = context
        .wait(response.chunk())
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| format!("读取响应失败：{}", error.without_url()))?
    {
        if bytes
            .len()
            .checked_add(chunk.len())
            .is_none_or(|size| size > limits.max_download_bytes)
        {
            return Err(format!(
                "响应超过 {} MiB 下载上限",
                limits.max_download_bytes / (1024 * 1024)
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    let mut download = Download {
        url: url.to_string(),
        bytes,
        content_type,
        requires_browser: mitigated,
    };
    if html && !mitigated {
        let document = scraper::Html::parse_document(&download.text()?);
        let script = scraper::Selector::parse("script").expect("固定选择器有效");
        download.requires_browser = document.select(&script).any(|node| {
            node.text().collect::<String>().contains("_cf_chl_opt")
                || node
                    .value()
                    .attr("src")
                    .is_some_and(|source| source.contains("/cdn-cgi/challenge-platform/"))
        });
    }
    if !status.is_success() && !download.requires_browser {
        return Err(status_error(status.as_u16()));
    }
    Ok(download)
}

fn status_error(status: u16) -> String {
    match status {
        429 => "HTTP 429：搜索源或页面请求被限流，请稍后重试".into(),
        401 | 403 => format!("HTTP {status}：目标拒绝访问或需要登录"),
        _ => format!("HTTP {status}：目标返回失败状态"),
    }
}

/// 在 `context` 和 `limits` 预算内下载公开 `source`，返回有界字节及最终 URL。
/// 每次跳转重新检查目标；地址受限、代理失败、HTTP 错误、超限或取消均返回明确原因。
pub(super) async fn download(
    source: &str,
    context: &ExecutionContext,
    limits: &WebLimits,
) -> Result<Download, String> {
    if source.chars().count() > 8192 {
        return Err("URL 超过 8192 字符上限".into());
    }
    let mut url = Url::parse(source).map_err(|_| "URL 无效，必须提供绝对 HTTP(S) 地址")?;
    for redirect in 0..=5 {
        let client = checked_client(&url, context, limits).await?;
        let response = context
            .wait(client.get(url.clone()).send())
            .await
            .map_err(|error| error.to_string())?
            .map_err(|error| format!("网络请求失败：{}", error.without_url()))?;
        if !response.status().is_redirection() {
            return read_response(response, &url, context, limits).await;
        }
        if redirect == 5 {
            return Err("网页跳转超过 5 次上限".into());
        }
        let location = response
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|value| value.to_str().ok())
            .ok_or("网页跳转缺少有效 Location")?;
        url = url.join(location).map_err(|_| "网页跳转地址无效")?;
    }
    Err("网页跳转未能完成".into())
}
