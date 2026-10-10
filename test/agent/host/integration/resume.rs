use super::{model, wait};
use noemori_agent::{
    Error, Role,
    host::{DesktopSession, DesktopSessionOptions, HostRunStatus},
    llm::ModelEvent,
};
use serde_json::json;
use std::sync::Arc;

#[tokio::test]
async fn resume_retries_a_model_stream_that_failed_after_its_finish_event() {
    let root = tempfile::tempdir().unwrap();
    let model = Arc::new(model::ScriptedModel::new(vec![
        vec![
            model::calls(&[(
                "unverified",
                "terminal",
                json!({"action":"exec", "cmd":"printf bad > forbidden.txt", "yield_time_ms":5000}),
            )]),
            Ok(ModelEvent::TextDelta("完成事件后的非法尾部".into())),
        ],
        vec![model::answer("重新请求后完成")],
    ]));
    let host = DesktopSession::new(
        model.clone(),
        DesktopSessionOptions::new(root.path()),
        Arc::new(|| {}),
    )
    .unwrap();
    let run = host.start("原任务".into()).unwrap();
    wait(&host, |view| {
        view.run
            .as_ref()
            .is_some_and(|run| run.status == HostRunStatus::Failed)
    })
    .await;
    host.resume(&run).unwrap();
    wait(&host, |view| {
        view.run
            .as_ref()
            .is_some_and(|run| run.status == HostRunStatus::Completed)
    })
    .await;
    assert!(!root.path().join("forbidden.txt").exists());
    {
        let requests = model.requests.lock().unwrap();
        assert_eq!(
            serde_json::to_value(&requests[0].messages).unwrap(),
            serde_json::to_value(&requests[1].messages).unwrap()
        );
    }
    host.close().await.unwrap();
}

#[tokio::test]
async fn resume_reissues_the_interrupted_model_request_without_extra_context() {
    let root = tempfile::tempdir().unwrap();
    let model = Arc::new(model::ScriptedModel::new(vec![
        vec![model::calls(&[(
            "once",
            "terminal",
            json!({"action":"exec", "cmd":"printf tick >> actions.txt", "yield_time_ms":5000}),
        )])],
        vec![
            Ok(ModelEvent::TextDelta("未完成片段".into())),
            Err(Error::Protocol("请求中断".into())),
        ],
        vec![model::answer("完成")],
    ]));
    let host = DesktopSession::new(
        model.clone(),
        DesktopSessionOptions::new(root.path()),
        Arc::new(|| {}),
    )
    .unwrap();
    let run = host
        .start_with_context("处理文章".into(), "原始文章上下文".into())
        .unwrap();
    wait(&host, |view| {
        view.run
            .as_ref()
            .is_some_and(|run| run.status == HostRunStatus::Failed)
    })
    .await;
    let checkpoint = host.checkpoint().unwrap();
    let saved = serde_json::to_value(&checkpoint).unwrap();
    assert_eq!(saved["history"].as_array().unwrap().len(), 5);
    host.close().await.unwrap();
    let restored = DesktopSession::new(
        model.clone(),
        DesktopSessionOptions::new(root.path()),
        Arc::new(|| {}),
    )
    .unwrap();
    restored
        .restore(serde_json::from_value(saved).unwrap())
        .unwrap();
    let next = restored.resume(&run).unwrap();
    assert_ne!(next, run);
    assert!(restored.resume(&run).is_err());
    assert!(restored.interrupt(&run).await.is_err());
    let finished = wait(&restored, |view| {
        view.run
            .as_ref()
            .is_some_and(|run| run.status == HostRunStatus::Completed)
    })
    .await;
    assert_eq!(
        finished
            .messages
            .iter()
            .filter(|message| message.role == Role::User)
            .count(),
        1
    );
    assert_eq!(finished.turns.len(), 2);
    assert_eq!(
        finished.turns[1].resumed_from.as_deref(),
        Some(run.as_str())
    );
    {
        let requests = model.requests.lock().unwrap();
        assert_eq!(requests.len(), 3);
        assert_eq!(
            serde_json::to_value(&requests[1].messages).unwrap(),
            serde_json::to_value(&requests[2].messages).unwrap()
        );
        assert!(
            !serde_json::to_string(&requests[2].messages)
                .unwrap()
                .contains("未完成片段")
        );
    }
    assert_eq!(
        std::fs::read_to_string(root.path().join("actions.txt")).unwrap(),
        "tick"
    );
    let checkpoint = restored.checkpoint().unwrap();
    checkpoint
        .branch_after(Some(&run))
        .unwrap()
        .snapshot()
        .unwrap();
    checkpoint
        .branch_after(Some(&next))
        .unwrap()
        .snapshot()
        .unwrap();
    assert!(restored.resume(&next).is_err());
    restored.close().await.unwrap();
}

#[tokio::test]
async fn resume_restores_tool_cursor_and_never_replays_confirmed_or_uncertain_actions() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let model = Arc::new(model::ScriptedModel::new(vec![
        vec![model::calls(&[
            (
                "done",
                "terminal",
                json!({"action":"exec", "cmd":"printf first >> actions.txt", "yield_time_ms":5000}),
            ),
            (
                "uncertain",
                "terminal",
                json!({"action":"exec", "cmd":"printf forbidden >> actions.txt", "permission_request":{"reason":"需要确认", "readable_paths":[outside.path()]}, "yield_time_ms":5000}),
            ),
            (
                "remaining",
                "terminal",
                json!({"action":"exec", "cmd":"printf second >> actions.txt", "yield_time_ms":5000}),
            ),
        ])],
        vec![model::answer("完成")],
    ]));
    let host = DesktopSession::new(
        model.clone(),
        DesktopSessionOptions::new(root.path()),
        Arc::new(|| {}),
    )
    .unwrap();
    let run = host.start("顺序执行任务".into()).unwrap();
    wait(&host, |view| !view.approvals.is_empty()).await;
    host.steer(&run, "执行完剩余步骤后检查结果".into()).unwrap();
    // 活动检查点也必须拥有完整已提交历史与工具节点，不依赖进程退出后的最终报告。
    let checkpoint = host.checkpoint().unwrap();
    let saved = serde_json::to_value(&checkpoint).unwrap();
    let queued = saved["pending_inputs"][0].as_u64().unwrap();
    for invalid in [
        json!([usize::MAX]),
        json!([1]),
        json!([queued, queued]),
        json!([queued, 0]),
    ] {
        let mut damaged = saved.clone();
        damaged["pending_inputs"] = invalid.clone();
        damaged["turns"][0]["pending_inputs_after"] = invalid;
        let damaged: noemori_agent::host::HostCheckpoint = serde_json::from_value(damaged).unwrap();
        assert!(damaged.snapshot().is_err());
    }
    host.interrupt(&run).await.unwrap();
    host.close().await.unwrap();
    let restored = DesktopSession::new(
        model.clone(),
        DesktopSessionOptions::new(root.path()),
        Arc::new(|| {}),
    )
    .unwrap();
    restored
        .restore(serde_json::from_str(&serde_json::to_string(&checkpoint).unwrap()).unwrap())
        .unwrap();
    restored.resume(&run).unwrap();
    wait(&restored, |view| {
        view.run
            .as_ref()
            .is_some_and(|run| run.status == HostRunStatus::Completed)
    })
    .await;
    assert_eq!(
        std::fs::read_to_string(root.path().join("actions.txt")).unwrap(),
        "firstsecond"
    );
    {
        let requests = model.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        noemori_agent::validate_history(&requests[1].messages).unwrap();
        assert_eq!(requests[1].messages.last().unwrap().role, Role::User);
        assert_eq!(
            requests[1].messages.last().unwrap().text_content(),
            "执行完剩余步骤后检查结果"
        );
        let results: Vec<_> = requests[1]
            .messages
            .iter()
            .flat_map(|message| &message.content)
            .filter_map(|part| match part {
                noemori_agent::ContentPart::ToolResult(result) => Some(result),
                _ => None,
            })
            .collect();
        assert_eq!(
            results
                .iter()
                .map(|result| result.call_id.as_str())
                .collect::<Vec<_>>(),
            vec!["done", "uncertain", "remaining"]
        );
        assert_eq!(results[1].output["outcome"], "unknown");
    }
    let finished = restored.checkpoint().unwrap();
    let branch_root = tempfile::tempdir().unwrap();
    let branch_model = Arc::new(model::ScriptedModel::new(vec![vec![model::answer(
        "已处理补充",
    )]]));
    let branch = DesktopSession::new(
        branch_model.clone(),
        DesktopSessionOptions::new(branch_root.path()),
        Arc::new(|| {}),
    )
    .unwrap();
    branch
        .restore(
            finished
                .branch_after(Some(&run))
                .unwrap()
                .relocate(branch_root.path())
                .unwrap(),
        )
        .unwrap();
    branch.resume(&run).unwrap();
    wait(&branch, |view| {
        view.run
            .as_ref()
            .is_some_and(|run| run.status == HostRunStatus::Completed)
    })
    .await;
    {
        let requests = branch_model.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(
            requests[0].messages.last().unwrap().text_content(),
            "执行完剩余步骤后检查结果"
        );
        assert_eq!(
            requests[0]
                .messages
                .iter()
                .filter(|message| message.text_content() == "执行完剩余步骤后检查结果")
                .count(),
            1
        );
        noemori_agent::validate_history(&requests[0].messages).unwrap();
    }
    assert_eq!(
        std::fs::read_to_string(branch_root.path().join("actions.txt")).unwrap(),
        "second"
    );
    branch.close().await.unwrap();
    restored.close().await.unwrap();
}
