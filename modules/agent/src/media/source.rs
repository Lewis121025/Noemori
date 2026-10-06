use crate::Error;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use std::{fmt, sync::Arc};

/// 媒体来源；云引用带有明确归属，适配器不能把一个供应商的文件当作另一个供应商的文件。
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    content = "value",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum MediaSource {
    /// 本地文件字节；共享存储避免克隆历史时重复分配，发送时才编码为 Base64。
    Bytes(Arc<[u8]>),
    /// 由模型服务直接读取的 HTTP(S) URL；可带签名查询，不能带 URL 用户名或密码。
    Url(String),
    /// Gemini Files API 已上传且处理就绪的文件 URI；生命周期与所属项目由宿主管理。
    GeminiFile(String),
    /// Gemini/Vertex 可访问的 gs://bucket/object 引用。
    Gcs(String),
    /// Bedrock 可访问的 S3 对象，不由 Agent 下载或转存。
    S3 {
        /// s3://bucket/object URI。
        uri: String,
        /// 跨账号读取时可指定 12 位 AWS 账号；省略时沿用服务端权限。
        bucket_owner: Option<String>,
    },
}

impl MediaSource {
    /// 从本地字节创建可共享来源；不解码文件，调用方须提供与格式声明相符的内容。
    ///
    /// # 错误
    /// 空文件或超过 25 MiB 时返回配置错误；更大的文件应使用远端引用。
    pub fn bytes(data: Vec<u8>) -> Result<Self, Error> {
        let source = Self::Bytes(data.into());
        source.validate()?;
        Ok(source)
    }

    pub(crate) fn validate(&self) -> Result<(), Error> {
        match self {
            Self::Bytes(bytes) => {
                if bytes.is_empty() || bytes.len() > 25 * 1024 * 1024 {
                    return Err(Error::Config(
                        "音视频字节必须非空且不超过 25 MiB；大文件请使用 URL 或供应商文件引用"
                            .into(),
                    ));
                }
            }
            Self::Url(uri) => {
                let url = parse_uri(uri)?;
                if !matches!(url.scheme(), "http" | "https") {
                    return Err(Error::Config("媒体 URL 必须使用 HTTP(S)".into()));
                }
            }
            Self::GeminiFile(uri) => {
                let url = parse_uri(uri)?;
                let file = url
                    .path()
                    .strip_prefix("/v1beta/files/")
                    .or_else(|| url.path().strip_prefix("/v1/files/"));
                if url.scheme() != "https"
                    || url.host_str() != Some("generativelanguage.googleapis.com")
                    || url.port().is_some()
                    || url.query().is_some()
                    || !file.is_some_and(|id| {
                        !id.is_empty() && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
                    })
                {
                    return Err(Error::Config(
                        "Gemini 文件引用必须是 Files API 返回的完整文件 URI".into(),
                    ));
                }
            }
            Self::Gcs(uri) => validate_object_uri(uri, "gs")?,
            Self::S3 { uri, bucket_owner } => {
                validate_object_uri(uri, "s3")?;
                if bucket_owner.as_ref().is_some_and(|owner| {
                    owner.len() != 12 || !owner.bytes().all(|c| c.is_ascii_digit())
                }) {
                    return Err(Error::Config(
                        "S3 bucket_owner 必须是 12 位 AWS 账号".into(),
                    ));
                }
            }
        }
        Ok(())
    }
}

fn parse_uri(uri: &str) -> Result<Url, Error> {
    if uri.is_empty()
        || uri.len() > 8192
        || uri.chars().any(char::is_whitespace)
        || uri.chars().any(char::is_control)
    {
        return Err(Error::Config(
            "媒体引用必须非空、不含空白或控制字符且不超过 8192 字节".into(),
        ));
    }
    let url = Url::parse(uri).map_err(|_| Error::Config("媒体引用 URL 无效".into()))?;
    if url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(Error::Config(
            "媒体引用必须有主机，且不能包含用户信息或片段".into(),
        ));
    }
    Ok(url)
}

fn validate_object_uri(uri: &str, scheme: &str) -> Result<(), Error> {
    let url = parse_uri(uri)?;
    if url.scheme() != scheme
        || url.path().len() < 2
        || url.port().is_some()
        || url.query().is_some()
    {
        return Err(Error::Config(format!(
            "媒体对象引用必须是 {scheme}://bucket/object"
        )));
    }
    Ok(())
}

impl fmt::Debug for MediaSource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Bytes(bytes) => f.debug_struct("Bytes").field("len", &bytes.len()).finish(),
            Self::Url(_) => f.write_str("Url([redacted])"),
            Self::GeminiFile(_) => f.write_str("GeminiFile([redacted])"),
            Self::Gcs(_) => f.write_str("Gcs([redacted])"),
            Self::S3 { .. } => f.write_str("S3([redacted])"),
        }
    }
}
