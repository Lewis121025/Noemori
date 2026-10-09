#![cfg(any(target_os = "macos", target_os = "linux"))]
#[path = "../../support/model.rs"]
mod model;
mod recovery;
mod attachments;
mod steering;
mod terminal_order;
use noemori_agent::{
    host::{DesktopSession, DesktopSessionOptions, HostApprovalReply, HostRunStatus},
    llm::ModelEvent,
    tool::terminal::TerminalApprovalDecision,
};
use serde_json::json;
use std::{sync::Arc, time::Duration};

async fn wait(
    host: &DesktopSession,
    condition: impl Fn(&noemori_agent::host::HostSnapshot) -> bool,
) -> noemori_agent::host::HostSnapshot {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let snapshot = host.snapshot();
            if condition(&snapshot) {
                return snapshot;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn checkpoint_restores_closed_history_without_replaying_tools() {
    let root = tempfile::tempdir().unwrap();
    let model = Arc::new(model::ScriptedModel::new(vec![vec![model::answer(
        "已记住项目计划",
    )]]));
    let first = DesktopSession::new(
        model,
        DesktopSessionOptions::new(root.path()),
        Arc::new(|| {}),
    )
    .unwrap();
    first.start("记住：项目叫远山".into()).unwrap();
    wait(&first, |view| {
        view.run
            .as_ref()
            .is_some_and(|run| run.status == HostRunStatus::Completed)
    })
    .await;
    let saved = serde_json::to_string(&first.checkpoint().unwrap()).unwrap();
    first.close().await.unwrap();
    let model = Arc::new(model::ScriptedModel::new(vec![vec![model::answer(
        "继续远山项目",
    )]]));
    let restored = DesktopSession::new(
        model.clone(),
        DesktopSessionOptions::new(root.path()),
        Arc::new(|| {}),
    )
    .unwrap();
    restored
        .restore(serde_json::from_str(&saved).unwrap())
        .unwrap();
    assert_eq!(restored.snapshot().messages.len(), 2);
    restored.start("继续".into()).unwrap();
    wait(&restored, |view| {
        view.run
            .as_ref()
            .is_some_and(|run| run.status == HostRunStatus::Completed)
    })
    .await;
    {
        let requests = model.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert!(
            serde_json::to_string(&requests[0].messages)
                .unwrap()
                .contains("项目叫远山")
        );
        noemori_agent::validate_history(&requests[0].messages).unwrap();
    }
    restored.close().await.unwrap();
}

#[tokio::test]
async fn each_turn_can_select_a_new_model_and_convert_private_continuation_data() {
    let root = tempfile::tempdir().unwrap();
    let mut response = model::answer("回答一").unwrap();
    if let ModelEvent::Finished(answer) = &mut response {
        answer
            .message
            .content
            .insert(0, noemori_agent::ContentPart::Reasoning("旧推理".into()));
        answer.message.provider_data = Some(noemori_agent::ProviderData::new(
            "openai-chat",
            "first",
            json!({"private_signature":"secret"}),
            &answer.message.content,
        ));
    }
    let first = Arc::new(model::ScriptedModel::new(vec![vec![Ok(response)]]));
    let second = Arc::new(model::ScriptedModel::new(vec![vec![model::answer(
        "回答二",
    )]]));
    let host = DesktopSession::new(
        first.clone(),
        DesktopSessionOptions::new(root.path()),
        Arc::new(|| {}),
    )
    .unwrap();
    host.start_configured(
        first.clone(),
        "provider:first".into(),
        "记住计划".into(),
        None,
    )
    .unwrap();
    wait(&host, |view| {
        view.run
            .as_ref()
            .is_some_and(|run| run.status == HostRunStatus::Completed)
    })
    .await;
    host.start_configured(
        second.clone(),
        "provider:second".into(),
        "继续计划".into(),
        None,
    )
    .unwrap();
    wait(&host, |view| {
        view.run
            .as_ref()
            .is_some_and(|run| run.status == HostRunStatus::Completed)
    })
    .await;
    assert_eq!(first.requests.lock().unwrap().len(), 1);
    {
        let requests = second.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert!(
            requests[0]
                .messages
                .iter()
                .all(|message| message.provider_data.is_none())
        );
        assert!(
            serde_json::to_string(&requests[0].messages)
                .unwrap()
                .contains("记住计划")
        );
        assert!(
            requests[0]
                .messages
                .iter()
                .flat_map(|message| &message.content)
                .all(|part| !matches!(part, noemori_agent::ContentPart::Reasoning(_)))
        );
        noemori_agent::validate_history(&requests[0].messages).unwrap();
    }
    assert_eq!(host.snapshot().turns.len(), 2);
    host.checkpoint().unwrap();
    host.close().await.unwrap();
}

#[tokio::test]
async fn empty_conversation_can_be_saved_branched_and_restored_before_its_first_message() {
    let root = tempfile::tempdir().unwrap();
    let model = Arc::new(model::ScriptedModel::new(vec![vec![model::answer(
        "开始工作",
    )]]));
    let source = DesktopSession::new(
        model.clone(),
        DesktopSessionOptions::new(root.path()),
        Arc::new(|| {}),
    )
    .unwrap();
    let checkpoint = source.checkpoint().unwrap();
    let branch = checkpoint.branch_after(None).unwrap();
    let view = branch.snapshot().unwrap();
    assert!(view.messages.is_empty() && view.turns.is_empty() && view.run.is_none());
    assert!(model.requests.lock().unwrap().is_empty());
    let restored = DesktopSession::new(
        model.clone(),
        DesktopSessionOptions::new(root.path()),
        Arc::new(|| {}),
    )
    .unwrap();
    restored.restore(branch).unwrap();
    restored.start("第一条任务".into()).unwrap();
    wait(&restored, |view| {
        view.run
            .as_ref()
            .is_some_and(|run| run.status == HostRunStatus::Completed)
    })
    .await;
    assert_eq!(model.requests.lock().unwrap().len(), 1);
    let mut damaged = serde_json::to_value(checkpoint).unwrap();
    damaged["messages"] =
        json!([{ "role": "user", "content": [{ "type": "text", "value": "缺少模型上下文" }] }]);
    let damaged: noemori_agent::host::HostCheckpoint = serde_json::from_value(damaged).unwrap();
    assert!(damaged.snapshot().is_err());
    restored.close().await.unwrap();
    source.close().await.unwrap();
}

#[tokio::test]
async fn article_context_is_sent_each_turn_without_changing_visible_user_messages_and_can_relocate()
{
    let root = tempfile::tempdir().unwrap();
    let moved = tempfile::tempdir().unwrap();
    let model = Arc::new(model::ScriptedModel::new(vec![
        vec![model::answer("回答一")],
        vec![model::answer("回答二")],
    ]));
    let source = DesktopSession::new(
        model.clone(),
        DesktopSessionOptions::new(root.path()),
        Arc::new(|| {}),
    )
    .unwrap();
    source
        .start_with_context("为什么？".into(), "文章：光学.md；本轮段落：折射".into())
        .unwrap();
    wait(&source, |view| {
        view.run
            .as_ref()
            .is_some_and(|run| run.status == HostRunStatus::Completed)
    })
    .await;
    assert_eq!(
        source.snapshot().messages[0].content,
        noemori_agent::Message::text(noemori_agent::Role::User, "为什么？").content
    );
    let saved = source.checkpoint().unwrap().relocate(moved.path()).unwrap();
    let restored = DesktopSession::new(
        model.clone(),
        DesktopSessionOptions::new(moved.path()),
        Arc::new(|| {}),
    )
    .unwrap();
    restored.restore(saved).unwrap();
    restored
        .start_with_context(
            "继续解释".into(),
            "文章：资料/光学.md；本轮段落：全反射".into(),
        )
        .unwrap();
    wait(&restored, |view| {
        view.run
            .as_ref()
            .is_some_and(|run| run.status == HostRunStatus::Completed)
    })
    .await;
    {
        let requests = model.requests.lock().unwrap();
        let messages = &requests[1].messages;
        assert_eq!(
            messages[messages.len() - 2].text_content(),
            "文章：资料/光学.md；本轮段落：全反射"
        );
        noemori_agent::validate_history(messages).unwrap();
    }
    assert_eq!(restored.snapshot().turns.len(), 2);
    source.close().await.unwrap();
    restored.close().await.unwrap();
}

#[tokio::test]
async fn checkpoint_interrupts_pending_approval_and_rejects_another_workspace() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let secret = root.path().join("secret");
    std::fs::write(&secret, "outside").unwrap();
    let model = Arc::new(model::ScriptedModel::new(vec![vec![model::calls(&[(
        "approval",
        "terminal",
        json!({"action":"exec","cmd":"touch should-not-run","permission_request":{"reason":"读取外部文件","readable_paths":[secret]}}),
    )])]]));
    let first = DesktopSession::new(
        model,
        DesktopSessionOptions::new(&workspace),
        Arc::new(|| {}),
    )
    .unwrap();
    first.start("执行".into()).unwrap();
    wait(&first, |view| !view.approvals.is_empty()).await;
    let checkpoint = first.checkpoint().unwrap();
    first.close().await.unwrap();
    let model = Arc::new(model::ScriptedModel::new(vec![vec![model::answer(
        "等待新指令",
    )]]));
    let wrong = DesktopSession::new(
        model.clone(),
        DesktopSessionOptions::new(root.path()),
        Arc::new(|| {}),
    )
    .unwrap();
    assert!(wrong.restore(checkpoint.clone()).is_err());
    wrong.close().await.unwrap();
    let restored = DesktopSession::new(
        model.clone(),
        DesktopSessionOptions::new(&workspace),
        Arc::new(|| {}),
    )
    .unwrap();
    restored.restore(checkpoint).unwrap();
    assert!(restored.snapshot().approvals.is_empty());
    assert!(restored.snapshot().terminals.is_empty());
    assert_eq!(
        restored.snapshot().run.unwrap().status,
        HostRunStatus::Cancelled
    );
    restored.start("先检查状态".into()).unwrap();
    wait(&restored, |view| {
        view.run
            .as_ref()
            .is_some_and(|run| run.status == HostRunStatus::Completed)
    })
    .await;
    assert!(
        serde_json::to_string(&model.requests.lock().unwrap()[0].messages)
            .unwrap()
            .contains("不能自动重放")
    );
    assert!(!workspace.join("should-not-run").exists());
    restored.close().await.unwrap();
}

#[tokio::test]
async fn desktop_session_commits_closed_history_and_retains_terminal_output_for_an_independent_reader()
 {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("note.txt"), "needle\n").unwrap();
    let model = Arc::new(model::ScriptedModel::new(vec![
        vec![model::calls(&[(
            "search",
            "terminal",
            json!({"action":"exec","cmd":"rg -n needle note.txt","yield_time_ms":5000}),
        )])],
        vec![
            Ok(ModelEvent::TextDelta("完成".into())),
            model::answer("完成"),
        ],
        vec![model::answer("下一轮")],
    ]));
    let host = DesktopSession::new(
        model.clone(),
        DesktopSessionOptions::new(root.path()),
        Arc::new(|| {}),
    )
    .unwrap();
    host.start("搜索文件".into()).unwrap();
    let snapshot = wait(&host, |snapshot| {
        snapshot
            .run
            .as_ref()
            .is_some_and(|run| run.status == HostRunStatus::Completed)
    })
    .await;
    assert_eq!(
        snapshot.messages.last().unwrap().content,
        noemori_agent::Message::text(noemori_agent::Role::Assistant, "完成").content
    );
    assert_eq!(snapshot.terminals.len(), 1);
    let page = host
        .read_terminal(&snapshot.terminals[0].process.session_id, 0, 8192)
        .await
        .unwrap();
    let bytes: Vec<_> = page
        .chunks
        .iter()
        .flat_map(|chunk| {
            base64::Engine::decode(
                &base64::engine::general_purpose::STANDARD,
                &chunk.data_base64,
            )
            .unwrap()
        })
        .collect();
    assert_eq!(bytes, b"1:needle\n");
    host.start("继续".into()).unwrap();
    wait(&host, |snapshot| {
        snapshot
            .run
            .as_ref()
            .is_some_and(|run| run.status == HostRunStatus::Completed)
    })
    .await;
    {
        let requests = model.requests.lock().unwrap();
        assert_eq!(requests.len(), 3);
        noemori_agent::validate_history(&requests[2].messages).unwrap();
    }
    host.close().await.unwrap();
    assert!(host.snapshot().closed);
    assert!(host.start("已关闭".into()).is_err());
}

#[tokio::test]
async fn cancelling_an_approval_removes_it_and_late_consent_cannot_execute_the_command() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let secret = root.path().join("secret");
    std::fs::write(&secret, "outside").unwrap();
    let model = Arc::new(model::ScriptedModel::new(vec![vec![model::calls(&[(
        "approval",
        "terminal",
        json!({"action":"exec","cmd":"touch should-not-run","permission_request":{"reason":"读取外部文件","readable_paths":[secret]}}),
    )])]]));
    let host = DesktopSession::new(
        model,
        DesktopSessionOptions::new(&workspace),
        Arc::new(|| {}),
    )
    .unwrap();
    host.start("执行".into()).unwrap();
    let pending = wait(&host, |snapshot| !snapshot.approvals.is_empty()).await;
    let approval = pending.approvals[0].id.clone();
    host.cancel();
    wait(&host, |snapshot| {
        snapshot
            .run
            .as_ref()
            .is_some_and(|run| run.status == HostRunStatus::Cancelled)
    })
    .await;
    assert!(host.snapshot().approvals.is_empty());
    assert!(
        host.resolve_approval(
            &approval,
            HostApprovalReply::Terminal(TerminalApprovalDecision::AllowOnce)
        )
        .is_err()
    );
    assert!(!workspace.join("should-not-run").exists());
    host.close().await.unwrap();
}

#[tokio::test]
async fn closing_a_desktop_session_reaps_background_terminals_after_the_model_run_has_finished() {
    let root = tempfile::tempdir().unwrap();
    let model = Arc::new(model::ScriptedModel::new(vec![
        vec![model::calls(&[(
            "background",
            "terminal",
            json!({"action":"exec","cmd":"printf ready; sleep 30","yield_time_ms":0}),
        )])],
        vec![model::answer("后台已启动")],
    ]));
    let host = DesktopSession::new(
        model,
        DesktopSessionOptions::new(root.path()),
        Arc::new(|| {}),
    )
    .unwrap();
    host.start("后台".into()).unwrap();
    wait(&host, |snapshot| {
        snapshot
            .run
            .as_ref()
            .is_some_and(|run| run.status == HostRunStatus::Completed)
    })
    .await;
    assert_eq!(host.snapshot().terminals.len(), 1);
    host.close().await.unwrap();
    assert!(
        host.snapshot()
            .terminals
            .iter()
            .all(|terminal| terminal.process.status
                != noemori_agent::tool::terminal::TerminalStatus::Running)
    );
}

#[tokio::test]
async fn interruption_waits_for_settlement_and_cannot_cancel_a_newer_run() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let outside = root.path().join("outside");
    std::fs::write(&outside, "fixture").unwrap();
    let model = Arc::new(model::ScriptedModel::new(vec![
        vec![model::calls(&[(
            "pending",
            "terminal",
            json!({
                "action": "exec", "cmd": "touch should-not-run",
                "permission_request": {"reason": "等待审批", "readable_paths": [outside]}
            }),
        )])],
        vec![model::answer("继续前已确认之前没有执行该操作")],
    ]));
    let host = DesktopSession::new(
        model,
        DesktopSessionOptions::new(&workspace),
        Arc::new(|| {}),
    )
    .unwrap();
    let first = host.start("启动需要审批的任务".into()).unwrap();
    wait(&host, |snapshot| !snapshot.approvals.is_empty()).await;
    host.interrupt(&first).await.unwrap();
    let stopped = host.snapshot();
    assert_eq!(stopped.run.unwrap().status, HostRunStatus::Cancelled);
    assert!(stopped.approvals.is_empty());
    assert!(!workspace.join("should-not-run").exists());
    let next = host.start("继续未完成的任务".into()).unwrap();
    assert_ne!(first, next);
    assert!(host.interrupt(&first).await.is_err());
    wait(&host, |snapshot| {
        snapshot
            .run
            .as_ref()
            .is_some_and(|run| run.status == HostRunStatus::Completed)
    })
    .await;
    host.interrupt(&next).await.unwrap();
    assert_eq!(
        host.snapshot().run.unwrap().status,
        HostRunStatus::Completed
    );
    host.close().await.unwrap();
}

#[tokio::test]
async fn turn_branch_preserves_provider_history_and_omits_later_turns() {
    let root = tempfile::tempdir().unwrap();
    let mut signed = model::answer("第一轮结论").unwrap();
    if let ModelEvent::Finished(response) = &mut signed {
        response.message.provider_data = Some(noemori_agent::ProviderData::new(
            "fixture",
            "fixture",
            json!({"signature": "private-proof"}),
            &response.message.content,
        ));
    }
    let model = Arc::new(model::ScriptedModel::new(vec![
        vec![Ok(signed)],
        vec![model::answer("第二轮结论")],
    ]));
    let source = DesktopSession::new(
        model,
        DesktopSessionOptions::new(root.path()),
        Arc::new(|| {}),
    )
    .unwrap();
    let first = source.start("第一轮问题".into()).unwrap();
    wait(&source, |view| {
        view.run
            .as_ref()
            .is_some_and(|run| run.status == HostRunStatus::Completed)
    })
    .await;
    source.start("第二轮问题".into()).unwrap();
    wait(&source, |view| {
        view.run
            .as_ref()
            .is_some_and(|run| run.status == HostRunStatus::Completed)
    })
    .await;
    let saved = source.checkpoint().unwrap();
    let original = serde_json::to_value(&saved).unwrap();
    let branch = saved.branch_after(Some(&first)).unwrap();
    let view = branch.snapshot().unwrap();
    assert_eq!(view.messages.len(), 2);
    assert_eq!(view.turns.len(), 1);
    assert!(view.terminals.is_empty() && view.approvals.is_empty());
    assert!(
        !serde_json::to_string(&view)
            .unwrap()
            .contains("private-proof")
    );
    assert_eq!(serde_json::to_value(&saved).unwrap(), original);
    let model = Arc::new(model::ScriptedModel::new(vec![vec![model::answer(
        "分支结论",
    )]]));
    let fork = DesktopSession::new(
        model.clone(),
        DesktopSessionOptions::new(root.path()),
        Arc::new(|| {}),
    )
    .unwrap();
    fork.restore(branch).unwrap();
    fork.start("换个方向".into()).unwrap();
    wait(&fork, |view| {
        view.run
            .as_ref()
            .is_some_and(|run| run.status == HostRunStatus::Completed)
    })
    .await;
    {
        let requests = model.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        let history = &requests[0].messages;
        noemori_agent::validate_history(history).unwrap();
        let serialized = serde_json::to_string(history).unwrap();
        assert!(serialized.contains("private-proof"));
        assert!(!serialized.contains("第二轮问题"));
        assert_eq!(history.last().unwrap().text_content(), "换个方向");
    }
    assert_eq!(source.snapshot().messages.len(), 4);
    source.close().await.unwrap();
    fork.close().await.unwrap();
}

#[tokio::test]
async fn branch_rejects_corrupt_boundaries_and_preserves_legacy_history() {
    let root = tempfile::tempdir().unwrap();
    let model = Arc::new(model::ScriptedModel::new(vec![vec![model::answer(
        "完整回答",
    )]]));
    let source = DesktopSession::new(
        model,
        DesktopSessionOptions::new(root.path()),
        Arc::new(|| {}),
    )
    .unwrap();
    source.start("问题".into()).unwrap();
    wait(&source, |view| {
        view.run
            .as_ref()
            .is_some_and(|run| run.status == HostRunStatus::Completed)
    })
    .await;
    let checkpoint = source.checkpoint().unwrap();
    let mut damaged = serde_json::to_value(&checkpoint).unwrap();
    damaged["turns"][0]["history_end"] = json!(usize::MAX);
    let damaged: noemori_agent::host::HostCheckpoint = serde_json::from_value(damaged).unwrap();
    assert!(damaged.branch_after(None).is_err());
    assert!(checkpoint.branch_after(Some("missing")).is_err());
    let mut legacy = serde_json::to_value(&checkpoint).unwrap();
    legacy["version"] = json!(1);
    legacy.as_object_mut().unwrap().remove("turns");
    let legacy: noemori_agent::host::HostCheckpoint = serde_json::from_value(legacy).unwrap();
    let branched = legacy.branch_after(None).unwrap();
    assert_eq!(branched.snapshot().unwrap().messages.len(), 2);
    assert!(branched.snapshot().unwrap().turns.is_empty());
    source.close().await.unwrap();
}

#[tokio::test]
async fn continuing_after_interrupt_preserves_unfinished_streamed_text() {
    use futures::StreamExt;
    use noemori_agent::llm::{Capabilities, Model, ModelRequest, ModelStream};
    use std::sync::Mutex;

    struct InterruptedModel(Mutex<Vec<ModelRequest>>);
    impl Model for InterruptedModel {
        fn capabilities(&self) -> Capabilities {
            Capabilities {
                tools: true,
                streaming: true,
                ..Default::default()
            }
        }
        fn generate(
            &self,
            request: ModelRequest,
            _: noemori_agent::ExecutionContext,
        ) -> ModelStream {
            let mut requests = self.0.lock().unwrap();
            requests.push(request);
            if requests.len() == 1 {
                Box::pin(futures::stream::iter(vec![model::calls(&[(
                    "read",
                    "terminal",
                    json!({ "action": "exec", "cmd": "printf committed-observation", "yield_time_ms": 5000 }),
                )])]))
            } else if requests.len() == 2 {
                Box::pin(
                    futures::stream::iter(vec![
                        Ok(ModelEvent::TextDelta("已解释第一点，".into())),
                        Ok(ModelEvent::TextDelta("第二点尚未完成".into())),
                    ])
                    .chain(futures::stream::pending()),
                )
            } else {
                Box::pin(futures::stream::iter(vec![model::answer("接着解释第二点")]))
            }
        }
    }

    let root = tempfile::tempdir().unwrap();
    let model = Arc::new(InterruptedModel(Mutex::new(Vec::new())));
    let host = DesktopSession::new(
        model.clone(),
        DesktopSessionOptions::new(root.path()),
        Arc::new(|| {}),
    )
    .unwrap();
    let run = host.start("解释两个要点".into()).unwrap();
    wait(&host, |view| {
        serde_json::to_string(&view.messages)
            .unwrap()
            .contains("第二点尚未完成")
    })
    .await;
    let live_branch = host.checkpoint().unwrap().branch_after(None).unwrap();
    let branch_view = live_branch.snapshot().unwrap();
    assert_eq!(branch_view.run.unwrap().status, HostRunStatus::Cancelled);
    assert!(branch_view.terminals.is_empty() && branch_view.approvals.is_empty());
    assert_eq!(host.snapshot().run.unwrap().status, HostRunStatus::Running);
    let branch_model = Arc::new(model::ScriptedModel::new(vec![vec![model::answer(
        "分支继续",
    )]]));
    let branch = DesktopSession::new(
        branch_model.clone(),
        DesktopSessionOptions::new(root.path()),
        Arc::new(|| {}),
    )
    .unwrap();
    branch.restore(live_branch).unwrap();
    branch.start("在分支上继续".into()).unwrap();
    wait(&branch, |view| {
        view.run
            .as_ref()
            .is_some_and(|run| run.status == HostRunStatus::Completed)
    })
    .await;
    {
        let requests = branch_model.requests.lock().unwrap();
        let history = &requests[0].messages;
        noemori_agent::validate_history(history).unwrap();
        let observed = serde_json::to_string(history).unwrap();
        assert_eq!(observed.matches("已解释第一点，第二点尚未完成").count(), 1);
        assert_eq!(observed.matches("committed-observation").count(), 2);
        assert_eq!(host.snapshot().run.unwrap().status, HostRunStatus::Running);
    }
    branch.close().await.unwrap();
    host.interrupt(&run).await.unwrap();
    host.start("继续未完成的任务".into()).unwrap();
    wait(&host, |view| {
        view.run
            .as_ref()
            .is_some_and(|run| run.status == HostRunStatus::Completed)
    })
    .await;
    {
        let requests = model.0.lock().unwrap();
        assert_eq!(requests.len(), 3);
        let history = &requests[2].messages;
        noemori_agent::validate_history(history).unwrap();
        let serialized = serde_json::to_string(history).unwrap();
        assert!(
            serialized.contains("已解释第一点，第二点尚未完成"),
            "继续时丢失已显示的部分回答：{serialized}"
        );
        assert_eq!(serialized.matches("已解释第一点").count(), 1);
        assert_eq!(
            history
                .iter()
                .flat_map(|message| message.tool_calls())
                .count(),
            1
        );
    }
    host.close().await.unwrap();
}

#[tokio::test]
async fn truncated_response_continues_with_final_content_without_private_payload_or_duplicate_deltas()
 {
    let root = tempfile::tempdir().unwrap();
    let mut truncated = model::answer("保留截断回答").unwrap();
    if let ModelEvent::Finished(response) = &mut truncated {
        response.finish_reason = noemori_agent::llm::FinishReason::Length;
        response.message.provider_data = Some(noemori_agent::ProviderData::new(
            "fixture",
            "fixture",
            json!({ "private": "private-reasoning-payload" }),
            &response.message.content,
        ));
    }
    let model = Arc::new(model::ScriptedModel::new(vec![
        vec![
            Ok(ModelEvent::TextDelta("保留截断回答".into())),
            Ok(truncated),
        ],
        vec![model::answer("补全回答")],
    ]));
    let host = DesktopSession::new(
        model.clone(),
        DesktopSessionOptions::new(root.path()),
        Arc::new(|| {}),
    )
    .unwrap();
    host.start("说明".into()).unwrap();
    wait(&host, |view| {
        view.run
            .as_ref()
            .is_some_and(|run| run.status == HostRunStatus::Truncated)
    })
    .await;
    host.start("继续".into()).unwrap();
    wait(&host, |view| {
        view.run
            .as_ref()
            .is_some_and(|run| run.status == HostRunStatus::Completed)
    })
    .await;
    {
        let requests = model.requests.lock().unwrap();
        let history = serde_json::to_string(&requests[1].messages).unwrap();
        assert_eq!(history.matches("保留截断回答").count(), 1);
        assert!(!history.contains("private-reasoning-payload"));
    }
    host.close().await.unwrap();
}
