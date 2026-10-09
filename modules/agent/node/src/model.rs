use noemori_agent::llm::{
    Authentication, AwsCredentials, AwsSigV4, Capabilities, HttpModel, ModelConfig, Protocol,
    ReasoningEffort,
};
use serde::Deserialize;
use std::sync::Arc;

/// 只有宿主配置入口接受认证；快照和状态通知不序列化此类型。
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Settings {
    pub(crate) protocol: String,
    pub(crate) model: String,
    pub(crate) endpoint: String,
    pub(crate) authentication: Auth,
    pub(crate) tools: bool,
    #[serde(default = "yes")]
    pub(crate) streaming: bool,
    #[serde(default)]
    pub(crate) vision: bool,
    #[serde(default)]
    pub(crate) audio: bool,
    #[serde(default)]
    pub(crate) video: bool,
    #[serde(default, rename = "reasoningEffort")]
    pub(crate) reasoning_effort: Option<ReasoningEffort>,
}
fn yes() -> bool {
    true
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum Auth {
    None,
    Bearer {
        value: String,
    },
    Header {
        name: String,
        value: String,
    },
    Aws {
        region: String,
        access_key: String,
        secret_key: String,
        session_token: Option<String>,
    },
}
impl Settings {
    pub(crate) fn build(self) -> Result<Arc<HttpModel>, String> {
        let protocol = match self.protocol.as_str() {
            "openai-chat" => Protocol::OpenAiChat,
            "openai-responses" => Protocol::OpenAiResponses,
            "anthropic" => Protocol::Anthropic,
            "vertex-anthropic" => Protocol::VertexAnthropic,
            "gemini" => Protocol::Gemini,
            "ollama" => Protocol::Ollama,
            "bedrock" => Protocol::Bedrock,
            _ => return Err("模型协议不支持".into()),
        };
        let mut config = ModelConfig::new(protocol, self.model, self.endpoint);
        config.capabilities = Capabilities {
            tools: self.tools,
            streaming: self.streaming,
            vision: self.vision,
            audio: self.audio,
            video: self.video,
        };
        config.reasoning_effort = self.reasoning_effort;
        config.authentication = match self.authentication {
            Auth::None => Authentication::None,
            Auth::Bearer { value } => Authentication::Bearer(value),
            Auth::Header { name, value } => Authentication::Header { name, value },
            Auth::Aws {
                region,
                access_key,
                secret_key,
                session_token,
            } => {
                if access_key.is_empty() || secret_key.is_empty() {
                    return Err("AWS 凭据不能为空".into());
                }
                Authentication::Dynamic(Arc::new(
                    AwsSigV4::new(
                        region,
                        AwsCredentials::new(
                            access_key,
                            secret_key,
                            session_token,
                            None,
                            "Noemori desktop",
                        ),
                    )
                    .map_err(|error| error.to_string())?,
                ))
            }
        };
        HttpModel::new(config)
            .map(Arc::new)
            .map_err(|error| error.to_string())
    }
}
