use super::model;
use noemori_agent::host::{DesktopSession, DesktopSessionOptions};
use serde_json::json;
use std::sync::Arc;

#[tokio::test]
async fn manual_terminal_tabs_keep_creation_order_and_interactive_metadata() {
    let root = tempfile::tempdir().unwrap();
    let host = DesktopSession::new(
        Arc::new(model::ScriptedModel::new(Vec::new())),
        DesktopSessionOptions::new(root.path()),
        Arc::new(|| {}),
    )
    .unwrap();
    let mut calls = Vec::new();
    for index in 0..4 {
        let result = host
            .terminal_action(json!({
                "action": "exec", "cmd": format!("printf terminal-{index}"),
                "tty": true, "yield_time_ms": 0,
            }))
            .await
            .unwrap();
        assert!(!result.is_error);
        calls.push(result.call_id);
        let snapshot = host.snapshot();
        assert!(snapshot.terminals.iter().all(|terminal| terminal.tty));
        assert_eq!(
            snapshot
                .terminals
                .iter()
                .map(|terminal| terminal.call_id.clone())
                .collect::<Vec<_>>(),
            calls
        );
    }
    host.close().await.unwrap();
}
