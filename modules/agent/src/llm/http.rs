use super::{
    Capabilities, Model, ModelConfig, ModelEvent, ModelRequest, ModelStream, Protocol, providers,
    transport,
};
use crate::{Error, ExecutionContext};
use futures::StreamExt;
use reqwest::{Client, Url};
use std::sync::Arc;

/// 基于 HTTP 的模型适配器；共享连接池，单次响应与解码状态互相隔离。
#[derive(Clone)]
pub struct HttpModel {
    client: Client,
    config: Arc<ModelConfig>,
}

impl HttpModel {
    /// 创建模型和连接池；不执行网络请求。
    ///
    /// # 错误
    /// 模型、URL、超时或响应上限无效时返回配置错误。
    pub fn new(config: ModelConfig) -> Result<Self, Error> {
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(transport::transport_error)?;
        Self::with_client(config, client)
    }

    /// 使用调用方连接池，可配置代理、企业 CA 或自定义 TLS。
    ///
    /// # 错误
    /// 与 new 使用同样的配置验证；调用方负责连接池的重定向策略。
    pub fn with_client(config: ModelConfig, client: Client) -> Result<Self, Error> {
        let url =
            Url::parse(&config.endpoint).map_err(|_| Error::Config("模型端点 URL 无效".into()))?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
        {
            return Err(Error::Config(
                "模型端点必须是 HTTP(S) URL，认证通过请求头提供".into(),
            ));
        }
        if config.model.trim().is_empty() || config.max_response_bytes == 0 {
            return Err(Error::Config("模型名和响应字节上限不能为空".into()));
        }
        ExecutionContext::new(crate::CancellationToken::new(), config.request_timeout)?;
        Ok(Self {
            client,
            config: Arc::new(config),
        })
    }

    async fn send(
        &self,
        request: &ModelRequest,
        context: &ExecutionContext,
    ) -> Result<reqwest::Response, Error> {
        let body = providers::request(&self.config, request)?;
        let mut builder = self
            .client
            .post(endpoint(&self.config)?)
            .headers(self.config.headers.clone())
            .json(&body);
        if self.config.protocol == Protocol::Anthropic
            && !self.config.headers.contains_key("anthropic-version")
        {
            builder = builder.header("anthropic-version", "2023-06-01");
        }
        let mut request = builder.build().map_err(transport::transport_error)?;
        context
            .wait(self.config.authentication.apply(&mut request))
            .await??;
        let response = context
            .wait(self.client.execute(request))
            .await?
            .map_err(transport::transport_error)?;
        if response.status().is_success() {
            return Ok(response);
        }
        let status = response.status().as_u16();
        let retry_after = response
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
            .map(std::time::Duration::from_secs);
        let bytes =
            transport::read_body(response, context.clone(), self.config.max_response_bytes).await?;
        let message = String::from_utf8_lossy(&bytes).chars().take(2048).collect();
        Err(Error::Http {
            status,
            message,
            retry_after,
        })
    }
}

impl Model for HttpModel {
    fn capabilities(&self) -> Capabilities {
        self.config.capabilities
    }

    fn generate(&self, request: ModelRequest, mut context: ExecutionContext) -> ModelStream {
        let model = self.clone();
        Box::pin(async_stream::try_stream! {
            request.validate(model.capabilities())?;
            context.check()?;
            let bounded = ExecutionContext::new(context.cancellation.clone(), model.config.request_timeout)?;
            context.deadline = context.deadline.min(bounded.deadline);
            let response = model.send(&request, &context).await?;
            if !model.config.capabilities.streaming {
                let bytes = transport::read_body(response, context, model.config.max_response_bytes).await?;
                let body = serde_json::from_slice(&bytes).map_err(|error| Error::Protocol(format!("响应不是 JSON：{error}")))?;
                yield ModelEvent::finished(providers::response(&model.config, body)?);
                return;
            }
            let mut decoder = providers::Decoder::new(model.config.protocol);
            let bytes = transport::limited_bytes(response, context, model.config.max_response_bytes);
            let mut frames = transport::events(bytes, model.config.protocol);
            while let Some(frame) = frames.next().await {
                let frame = frame?;
                if frame.trim().is_empty() { continue; }
                for event in decoder.feed(&model.config, frame.trim())? {
                    let finished = matches!(event, ModelEvent::Finished(_));
                    validate_terminal(&event)?;
                    yield event;
                    if finished { return; }
                }
            }
            let event = decoder.eof(&model.config)?;
            validate_terminal(&event)?;
            yield event;
        })
    }
}

fn validate_terminal(event: &ModelEvent) -> Result<(), Error> {
    if let ModelEvent::Finished(response) = event {
        response.validate()?;
    }
    Ok(())
}

fn endpoint(config: &ModelConfig) -> Result<Url, Error> {
    let mut url =
        Url::parse(&config.endpoint).map_err(|_| Error::Config("模型端点 URL 无效".into()))?;
    let path = url.path().to_owned();
    match config.protocol {
        Protocol::Gemini => {
            let target = if config.capabilities.streaming {
                ":streamGenerateContent"
            } else {
                ":generateContent"
            };
            if let Some(prefix) = path
                .strip_suffix(":streamGenerateContent")
                .or_else(|| path.strip_suffix(":generateContent"))
            {
                url.set_path(&format!("{prefix}{target}"));
            }
            let query: Vec<_> = url
                .query_pairs()
                .filter(|(key, _)| key != "alt")
                .map(|(key, value)| (key.into_owned(), value.into_owned()))
                .collect();
            url.set_query(None);
            url.query_pairs_mut().extend_pairs(query);
            if config.capabilities.streaming {
                url.query_pairs_mut().append_pair("alt", "sse");
            }
        }
        Protocol::Bedrock => {
            let target = if config.capabilities.streaming {
                "/converse-stream"
            } else {
                "/converse"
            };
            if let Some(prefix) = path
                .strip_suffix("/converse-stream")
                .or_else(|| path.strip_suffix("/converse"))
            {
                url.set_path(&format!("{prefix}{target}"));
            }
        }
        _ => {}
    }
    Ok(url)
}
