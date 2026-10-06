use async_trait::async_trait;
use base64::{Engine, engine::general_purpose::STANDARD};
use noemori_agent::llm::{Capabilities, Model, ModelRequest, ModelStream};
use noemori_agent::tool::ToolRegistry;
use noemori_agent::tool::web::{WebInput, WebLimits, WebRuntime, WebTool};
use noemori_agent::tool::{Tool, ToolContext, ToolError};
use noemori_agent::{CancellationToken, ExecutionContext, Image, ImageFormat, Media, ToolCall};
use serde_json::json;
use std::time::Duration;
#[path = "../../support/model.rs"]
mod scripted;

struct VisionModel(scripted::ScriptedModel);
impl Model for VisionModel {
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            tools: true,
            streaming: true,
            vision: true,
            audio: false,
            video: false,
        }
    }
    fn generate(&self, request: ModelRequest, context: ExecutionContext) -> ModelStream {
        self.0.generate(request, context)
    }
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct EmptyArgs {}
struct Scan;
fn page_image() -> Image {
    Image::new(ImageFormat::Png, STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhXcAAAAASUVORK5CYII=").unwrap()).unwrap()
}
#[async_trait]
impl Tool for Scan {
    type Args = EmptyArgs;
    type Output = serde_json::Value;
    fn name(&self) -> &str {
        "scan"
    }
    fn description(&self) -> &str {
        "返回 PDF 页图的测试工具"
    }
    fn media(&self, _: &Self::Output) -> Vec<Media> {
        vec![Media::Image(page_image())]
    }
    async fn execute(&self, _: EmptyArgs, _: ToolContext) -> Result<Self::Output, ToolError> {
        Ok(json!({"rendered_pages":[1]}))
    }
}

#[tokio::test]
async fn tool_images_commit_with_their_result_and_reach_the_next_model_request() {
    use noemori_agent::runtime::{Agent, RunInput, RunOptions, RunStatus};
    let model = std::sync::Arc::new(VisionModel(scripted::ScriptedModel::new(vec![
        vec![scripted::calls(&[("one", "scan", json!({}))])],
        vec![scripted::answer("读到了扫描页")],
    ])));
    let mut registry = ToolRegistry::new();
    registry.register(Scan).unwrap();
    let agent = Agent::new(model.clone(), registry, RunOptions::default()).unwrap();
    let report = agent
        .run(RunInput::new(vec![noemori_agent::Message::text(
            noemori_agent::Role::User,
            "读取 PDF",
        )]))
        .await
        .unwrap();
    assert!(matches!(report.status, RunStatus::Completed));
    let requests = model.0.requests.lock().unwrap();
    let noemori_agent::ContentPart::ToolResult(result) =
        &requests[1].messages.last().unwrap().content[0]
    else {
        panic!("缺少图像工具结果")
    };
    assert_eq!(result.call_id, "one");
    assert_eq!(result.media, [Media::Image(page_image())]);
    assert_eq!(result.output, json!({"rendered_pages":[1]}));
}
fn tool() -> WebTool {
    WebTool::new(
        WebRuntime {
            node: "node".into(),
            worker: std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../test/agent/web/support/worker-fixture.mjs"),
            browser: None,
        },
        WebLimits::default(),
    )
    .unwrap()
}
#[tokio::test]
async fn a_web_error_is_visible_to_the_next_agent_model_turn() {
    use noemori_agent::runtime::{Agent, RunInput, RunOptions, RunStatus};
    let model = std::sync::Arc::new(scripted::ScriptedModel::new(vec![
        vec![scripted::calls(&[(
            "one",
            "web",
            json!({"type":"fetch","url":"http://127.0.0.1/private"}),
        )])],
        vec![scripted::answer("目标不是公开页面，无法读取")],
    ]));
    let mut registry = ToolRegistry::new();
    registry.register(tool()).unwrap();
    let agent = Agent::new(model.clone(), registry, RunOptions::default()).unwrap();
    let report = agent
        .run(RunInput::new(vec![noemori_agent::Message::text(
            noemori_agent::Role::User,
            "读取页面",
        )]))
        .await
        .unwrap();
    assert!(matches!(report.status, RunStatus::Completed));
    let requests = model.requests.lock().unwrap();
    let result = &requests[1].messages.last().unwrap().content[0];
    assert!(
        matches!(result,noemori_agent::ContentPart::ToolResult(observation) if observation.is_error
        && observation.output["error"].as_str().unwrap().contains("非公开"))
    );
}

#[tokio::test]
async fn invalid_parameters_and_private_urls_are_clear_agent_observations() {
    let mut registry = ToolRegistry::new();
    registry.register(tool()).unwrap();
    for (arguments, reason) in [
        (json!({"type":"search","query":"  "}), "关键词"),
        (
            json!({"type":"search","query":"x","url":"https://example.com"}),
            "Schema",
        ),
        (
            json!({"type":"fetch","url":"http://127.0.0.1/secret"}),
            "非公开",
        ),
        (
            json!({"type":"fetch","url":"http://[::1]/secret"}),
            "非公开",
        ),
        (json!({"type":"fetch","url":"file:///etc/passwd"}), "HTTP"),
    ] {
        let context =
            ExecutionContext::new(CancellationToken::new(), Duration::from_secs(5)).unwrap();
        let observation = registry
            .execute(
                &ToolCall {
                    id: "test".into(),
                    name: "web".into(),
                    arguments,
                },
                context,
            )
            .await
            .unwrap();
        assert!(observation.is_error);
        assert!(
            observation.output["error"]
                .as_str()
                .unwrap()
                .contains(reason),
            "{:?}",
            observation.output
        );
    }
}

#[tokio::test]
async fn direct_execution_keeps_failures_explicit() {
    let context = ExecutionContext::new(CancellationToken::new(), Duration::from_secs(5)).unwrap();
    let error = tool()
        .execute(
            WebInput::Search { query: "".into() },
            noemori_agent::tool::ToolContext {
                call_id: "one".into(),
                execution: context,
                session: noemori_agent::AgentSession::new(),
            },
        )
        .await
        .unwrap_err();
    assert!(matches!(error,ToolError::Execution(message) if message.contains("关键词")));
}
