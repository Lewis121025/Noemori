//! 应用启动授权使用协议夹具验证，不启动真实桌面应用。
use noemori_agent::tool::ui::computer::ComputerInput;
use serde_json::json;

#[test]
fn launch_contract_rejects_executable_paths_arguments_and_host_only_preparation() {
    for bundle_id in [
        "/Applications/Editor.app",
        "com.example.Editor --argument",
        "",
        "../Editor",
    ] {
        let input: ComputerInput = serde_json::from_value(
            json!({"action":"launch_app","bundle_id":bundle_id,"reason":"验收"}),
        )
        .unwrap();
        assert!(input.validate().is_err());
    }
    for value in [
        json!({"action":"launch_info","bundle_id":"app.example.Editor"}),
        json!({"action":"launch_app","bundle_id":"app.example.Editor","reason":"验收","args":["--run"]}),
    ] {
        assert!(serde_json::from_value::<ComputerInput>(value).is_err());
    }
    let input: ComputerInput = serde_json::from_value(
        json!({"action":"launch_app","bundle_id":"app.example.Editor","reason":"验收"}),
    )
    .unwrap();
    input.validate().unwrap();
}

#[cfg(target_os = "macos")]
mod macos {
    use noemori_agent::{
        AgentSession, CancellationToken, ExecutionContext,
        tool::{
            Tool, ToolContext,
            ui::{
                UiConfig, UiInput, UiTool,
                broker::{ConnectionConfig, UiBroker},
                computer::{
                    UiAccessDecision, UiAccessRequest, UiApprover, UiLaunchApprover,
                    UiLaunchDecision, UiLaunchRequest,
                },
                wire,
            },
        },
    };
    use serde_json::json;
    use std::{
        sync::{Arc, Mutex},
        time::Duration,
    };

    #[derive(Clone, Copy)]
    enum Case {
        Missing,
        Deny,
        Changed,
        Allow,
    }
    struct Approver(Case);
    #[async_trait::async_trait]
    impl UiApprover for Approver {
        async fn approve(
            &self,
            _: UiAccessRequest,
            _: ExecutionContext,
        ) -> Result<UiAccessDecision, String> {
            panic!("启动不能借用窗口控制审批")
        }
    }
    #[async_trait::async_trait]
    impl UiLaunchApprover for Approver {
        async fn approve(
            &self,
            request: UiLaunchRequest,
            _: ExecutionContext,
        ) -> Result<UiLaunchDecision, String> {
            assert_eq!(request.bundle_id, "app.example.Editor");
            assert_eq!(request.app_name, "可信编辑器");
            assert_eq!(request.reason, "打开测试应用");
            Ok(if matches!(self.0, Case::Deny) {
                UiLaunchDecision::Deny("测试拒绝".into())
            } else {
                UiLaunchDecision::AllowOnce
            })
        }
    }

    fn native_peer(
        config: ConnectionConfig,
        case: Case,
        count: Arc<Mutex<usize>>,
    ) -> std::thread::JoinHandle<()> {
        std::thread::spawn(move || {
            let mut stream = std::os::unix::net::UnixStream::connect(config.socket).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            wire::write_message(&mut stream, &json!({"type":"hello","version":1,"backend":"computer","token":config.token,"name":"原生协议夹具"})).unwrap();
            assert_eq!(wire::read_message(&mut stream).unwrap()["type"], "welcome");
            let mut reads = 0;
            loop {
                let frame = wire::read_message(&mut stream).unwrap();
                if frame["type"] == "release" {
                    wire::write_message(&mut stream, &json!({"type":"result","id":frame["id"],"value":{"outcome":"executed","mode":"human"}})).unwrap();
                    break;
                }
                if frame["type"] != "call" {
                    continue;
                }
                assert_eq!(frame["action"]["bundle_id"], "app.example.Editor");
                let value = match frame["action"]["action"].as_str().unwrap() {
                    "launch_info" => {
                        reads += 1;
                        json!({"outcome":"observed","bundle_id":"app.example.Editor","app_name":if reads > 1 && matches!(case, Case::Changed) {"另一个应用"} else {"可信编辑器"}})
                    }
                    "launch_app" => {
                        assert!(matches!(case, Case::Allow));
                        *count.lock().unwrap() += 1;
                        json!({"outcome":"executed","app":"instance-one"})
                    }
                    other => panic!("意外的原生动作：{other}"),
                };
                wire::write_message(
                    &mut stream,
                    &json!({"type":"result","id":frame["id"],"value":value}),
                )
                .unwrap();
            }
        })
    }

    async fn run(case: Case) {
        let root = tempfile::tempdir().unwrap();
        let helper = root.path().join("Helper.app");
        let executable = helper.join("Contents/MacOS/noemori-computer-helper");
        std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
        std::fs::write(&executable, "fixture, must never be launched").unwrap();
        let broker =
            UiBroker::open(root.path().join("ui"), "a".repeat(32), Arc::new(|| {})).unwrap();
        let session = AgentSession::new();
        broker.register(session.id(), "启动授权验收");
        let config: ConnectionConfig =
            serde_json::from_slice(&std::fs::read(broker.configuration_path()).unwrap()).unwrap();
        let launched = Arc::new(Mutex::new(0usize));
        let peer = native_peer(config, case, launched.clone());
        tokio::time::timeout(Duration::from_secs(3), async {
            while broker.connections(session.id()).is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let approver = Arc::new(Approver(case));
        let mut tool = UiTool::new(env!("CARGO_BIN_EXE_noemori-ui-runtime").into(), None)
            .unwrap()
            .with_connections(
                UiConfig {
                    executable: env!("CARGO_BIN_EXE_noemori-ui-runtime").into(),
                    broker,
                    computer_helper: Some(helper),
                    workspace: root.path().into(),
                },
                approver.clone(),
            )
            .unwrap();
        if !matches!(case, Case::Missing) {
            tool = tool.with_launch_approver(approver);
        }
        let output = tool.execute(UiInput::Run { code: "print(JSON.parse(await __rpc(JSON.stringify({domain:'computer',action:{action:'launch_app',bundle_id:'app.example.Editor',reason:'打开测试应用'}}))));".into(), timeout_ms: 5000 }, ToolContext {
            call_id: "launch-one".into(), execution: ExecutionContext::new(CancellationToken::new(), Duration::from_secs(5)).unwrap(), session: session.clone(),
        }).await.unwrap();
        assert_eq!(
            output.operations[0]["outcome"],
            if matches!(case, Case::Allow) {
                "executed"
            } else {
                "not_executed"
            }
        );
        assert_eq!(
            *launched.lock().unwrap(),
            usize::from(matches!(case, Case::Allow))
        );
        session.close().await.unwrap();
        peer.join().unwrap();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn launch_requires_its_own_approval_and_rechecks_installation_identity() {
        for case in [Case::Missing, Case::Deny, Case::Changed, Case::Allow] {
            run(case).await;
        }
    }
}
