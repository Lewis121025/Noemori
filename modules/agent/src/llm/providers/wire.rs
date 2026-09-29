use super::{
    ModelConfig, ModelEvent, Protocol, anthropic, bedrock, chat, gemini, ollama, responses,
};
use crate::Error;
use serde_json::Value;

/// 每条模型流只持有其协议所需的聚合状态，避免跨协议共享不成立的状态约束。
enum State {
    Chat(chat::StreamState),
    Responses,
    Anthropic(anthropic::StreamState),
    Gemini(gemini::StreamState),
    Ollama(ollama::StreamState),
    Bedrock(bedrock::StreamState),
}

/// 将传输层已分帧的数据转换为统一事件，使网络分帧与模型消息状态分别承担校验职责。
pub(in crate::llm) struct Decoder(State);

impl Decoder {
    pub fn new(protocol: Protocol) -> Self {
        Self(match protocol {
            Protocol::OpenAiChat => State::Chat(chat::StreamState::default()),
            Protocol::OpenAiResponses => State::Responses,
            Protocol::Anthropic | Protocol::VertexAnthropic => {
                State::Anthropic(anthropic::StreamState::default())
            }
            Protocol::Gemini => State::Gemini(gemini::StreamState::default()),
            Protocol::Ollama => State::Ollama(ollama::StreamState::default()),
            Protocol::Bedrock => State::Bedrock(bedrock::StreamState::default()),
        })
    }

    pub fn feed(&mut self, config: &ModelConfig, text: &str) -> Result<Vec<ModelEvent>, Error> {
        if text == "[DONE]" {
            return match &mut self.0 {
                State::Chat(state) => Ok(vec![ModelEvent::finished(state.finish(config)?)]),
                _ => Err(Error::Protocol("协议不接受 [DONE]".into())),
            };
        }
        let body: Value = serde_json::from_str(text)
            .map_err(|error| Error::Protocol(format!("流事件不是 JSON：{error}")))?;
        if !body.is_object() {
            return Err(Error::Protocol("流事件必须是 JSON 对象".into()));
        }
        if let Some(error) = body.get("error").filter(|value| !value.is_null()) {
            return Err(Error::Protocol(format!("模型流失败：{error}")));
        }
        match &mut self.0 {
            State::Chat(state) => state.feed(body),
            State::Responses => responses::feed(config, body),
            State::Anthropic(state) => state.feed(config, body),
            State::Gemini(state) => state.feed(body),
            State::Ollama(state) => state.feed(config, body),
            State::Bedrock(state) => state.feed(body),
        }
    }

    pub fn eof(&self, config: &ModelConfig) -> Result<ModelEvent, Error> {
        match &self.0 {
            State::Gemini(state) => Ok(ModelEvent::finished(state.finish(config)?)),
            State::Bedrock(state) => Ok(ModelEvent::finished(state.finish(config)?)),
            _ => Err(Error::Protocol("连接结束前缺少协议终止标记".into())),
        }
    }
}
