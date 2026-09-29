//! 使用 AWS 官方签名实现，凭据提供器负责刷新和来源策略。

use super::RequestAuthenticator;
use crate::Error;
use async_trait::async_trait;
use aws_credential_types::provider::{ProvideCredentials, SharedCredentialsProvider};
use aws_sigv4::{
    http_request::{SignableBody, SignableRequest, SigningSettings, sign},
    sign::v4,
};
use reqwest::header::{HeaderName, HeaderValue};
use std::time::SystemTime;

/// Bedrock SigV4 请求认证；可接收静态凭据或 AWS SDK 的刷新凭据提供器。
pub struct AwsSigV4 {
    region: String,
    credentials: SharedCredentialsProvider,
}

impl AwsSigV4 {
    /// 绑定区域和凭据提供器；构造时不读取凭据或发送请求。
    ///
    /// # 错误
    /// 区域为空时返回配置错误。
    pub fn new(
        region: impl Into<String>,
        credentials: impl ProvideCredentials + 'static,
    ) -> Result<Self, Error> {
        let region = region.into();
        if region.trim().is_empty() {
            return Err(Error::Config("AWS 区域不能为空".into()));
        }
        Ok(Self {
            region,
            credentials: SharedCredentialsProvider::new(credentials),
        })
    }
}

#[async_trait]
impl RequestAuthenticator for AwsSigV4 {
    async fn authenticate(&self, request: &mut reqwest::Request) -> Result<(), Error> {
        let identity = self
            .credentials
            .provide_credentials()
            .await
            .map_err(|error| Error::Authentication(error.to_string()))?
            .into();
        let params = v4::SigningParams::builder()
            .identity(&identity)
            .region(&self.region)
            .name("bedrock")
            .time(SystemTime::now())
            .settings(SigningSettings::default())
            .build()
            .map_err(|error| Error::Authentication(error.to_string()))?
            .into();
        let headers: Vec<_> = request
            .headers()
            .iter()
            .map(|(name, value)| {
                value
                    .to_str()
                    .map(|value| (name.as_str(), value))
                    .map_err(|_| Error::Authentication("签名请求头必须可表示为文本".into()))
            })
            .collect::<Result<_, _>>()?;
        let body = request
            .body()
            .and_then(reqwest::Body::as_bytes)
            .ok_or_else(|| Error::Authentication("SigV4 需要完整请求体".into()))?;
        let signable = SignableRequest::new(
            request.method().as_str(),
            request.url().as_str(),
            headers.into_iter(),
            SignableBody::Bytes(body),
        )
        .map_err(|error| Error::Authentication(error.to_string()))?;
        let (instructions, _) = sign(signable, &params)
            .map_err(|error| Error::Authentication(error.to_string()))?
            .into_parts();
        for (name, value) in instructions.headers() {
            let name = HeaderName::from_bytes(name.as_bytes())
                .map_err(|_| Error::Authentication("签名头名称无效".into()))?;
            let mut value = HeaderValue::from_str(value)
                .map_err(|_| Error::Authentication("签名头值无效".into()))?;
            value.set_sensitive(true);
            request.headers_mut().insert(name, value);
        }
        Ok(())
    }
}
