#[cfg(target_os = "macos")]
#[tokio::test(flavor = "multi_thread")]
async fn signed_helper_launches_via_launch_services_and_reports_real_permissions() {
    use noemori_agent::{CancellationToken, ExecutionContext, tool::ui::broker::UiBroker};
    use std::{sync::Arc, time::Duration};
    let helper = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("node/runtime/NoemoriComputerHelper.app");
    assert!(
        helper
            .join("Contents/MacOS/noemori-computer-helper")
            .is_file(),
        "先构建 agent-node 的原生运行材料"
    );
    assert!(
        std::process::Command::new("/usr/bin/codesign")
            .args(["--verify", "--strict"])
            .arg(&helper)
            .status()
            .unwrap()
            .success()
    );
    let root = tempfile::tempdir().unwrap();
    let broker = UiBroker::open(
        root.path().into(),
        "adeahajhgekfhfgimpaokoahfajebajb".into(),
        Arc::new(|| {}),
    )
    .unwrap();
    broker.register("native-proof", "原生连接验收");
    let context = ExecutionContext::new(CancellationToken::new(), Duration::from_secs(15)).unwrap();
    broker.ensure_computer(&helper, &context).await.unwrap();
    let permissions = broker
        .execute(
            "native-proof",
            "computer",
            serde_json::json!({"action":"permissions"}),
            &context,
        )
        .await
        .unwrap();
    assert_eq!(permissions["outcome"], "observed");
    for field in ["accessibility", "screen_recording", "input_monitoring"] {
        assert!(permissions[field].is_boolean(), "真实权限回执缺少 {field}");
    }
    eprintln!("原生 helper 权限：{permissions}");
    broker.release_confirmed("native-proof").await.unwrap();
}
