use super::*;
use crate::{
    Message, Role,
    llm::{Capabilities, ModelResponse, ModelStream, Usage},
    runtime::{PendingTurn, RunControl, RunOptions},
    tool::ToolRegistry,
};
use std::sync::Mutex;

struct RecordingModel(Mutex<Vec<ModelRequest>>);

impl Model for RecordingModel {
    fn capabilities(&self) -> Capabilities {
        Capabilities::default()
    }

    fn generate(&self, request: ModelRequest, _: ExecutionContext) -> ModelStream {
        self.0.lock().unwrap().push(request);
        Box::pin(futures::stream::iter(vec![Ok(ModelEvent::finished(
            answer("已处理补充"),
        ))]))
    }
}

fn answer(text: &str) -> ModelResponse {
    ModelResponse {
        message: Message::text(Role::Assistant, text),
        finish_reason: FinishReason::Stop,
        usage: Usage::default(),
        response_id: None,
    }
}

#[tokio::test]
async fn verified_stop_is_committed_before_processing_queued_user_input() {
    let model = Arc::new(RecordingModel(Mutex::new(Vec::new())));
    let agent = Agent::new(model.clone(), ToolRegistry::new(), RunOptions::default()).unwrap();
    let control = RunControl::with_inputs(vec![Message::text(Role::User, "补充真实指令")]).unwrap();
    let pending = PendingTurn {
        model_completed: true,
        response: Some(answer("中断前已完成的回答")),
        ..Default::default()
    };
    let mut stream = agent
        .stream_with_control(
            RunInput::new(vec![Message::text(Role::User, "原任务")]),
            control,
            Some(pending),
        )
        .unwrap();
    let mut report = None;
    while let Some(event) = stream.next().await {
        if let AgentEvent::Finished(finished) = event {
            report = Some(finished);
        }
    }
    let report = report.unwrap();
    assert!(matches!(report.status, RunStatus::Completed));
    assert_eq!(report.model_calls, 1);
    assert!(report.pending_inputs.is_empty());
    let requests = model.0.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(
        requests[0].messages,
        vec![
            Message::text(Role::User, "原任务"),
            Message::text(Role::Assistant, "中断前已完成的回答"),
            Message::text(Role::User, "补充真实指令"),
        ]
    );
}

#[tokio::test]
async fn cancelled_recovery_keeps_queued_inputs_outside_committed_history() {
    let model = Arc::new(RecordingModel(Mutex::new(Vec::new())));
    let agent = Agent::new(model.clone(), ToolRegistry::new(), RunOptions::default()).unwrap();
    let original = vec![Message::text(Role::User, "原任务")];
    let queued = vec![Message::text(Role::User, "补充真实指令")];
    let control = RunControl::with_inputs(queued.clone()).unwrap();
    let input = RunInput::new(original.clone());
    input.cancellation.cancel();
    let mut stream = agent.stream_with_control(input, control, None).unwrap();
    let Some(AgentEvent::Finished(report)) = stream.next().await else {
        panic!("已取消运行必须交付终态");
    };
    assert!(matches!(report.status, RunStatus::Cancelled));
    assert_eq!(report.history, original);
    assert_eq!(report.pending_inputs, queued);
    assert!(model.0.lock().unwrap().is_empty());
}

#[test]
fn restored_input_batches_are_validated_without_applying_new_input_queue_limit() {
    let control =
        RunControl::with_inputs(vec![Message::text(Role::User, "已接受指令"); 17]).unwrap();
    assert!(control.push(Message::text(Role::User, "新的输入")).is_err());
    assert_eq!(control.drain().len(), 17);
    control.push(Message::text(Role::User, "新的输入")).unwrap();
    assert!(RunControl::with_inputs(vec![Message::text(Role::Assistant, "伪造用户输入")]).is_err());
}
