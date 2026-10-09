//! 可独立使用的模型协议层；不持有工具执行器或 Agent 状态。

mod auth;
mod config;
mod http;
mod model;
mod providers;
mod request;
mod response;
mod stream;
mod transport;

pub use auth::AwsSigV4;
pub use aws_credential_types::Credentials as AwsCredentials;
pub use config::{
    Authentication, ChatTokenLimit, ModelConfig, Protocol, ReasoningEffort, RequestAuthenticator,
};
pub use http::HttpModel;
pub(crate) use model::checked_stream;
pub use model::{Capabilities, Model, ModelStream, generate};
pub use request::{GenerationOptions, ModelRequest};
pub use response::{FinishReason, ModelResponse, Usage};
pub use stream::ModelEvent;
