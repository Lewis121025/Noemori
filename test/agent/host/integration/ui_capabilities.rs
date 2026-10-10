//! 验证模型请求经过真实宿主 Gate；浏览器由私有协议夹具替代，测试不访问用户网页。
use super::{model, wait};
use noemori_agent::{
    host::{
        DesktopSession, DesktopSessionOptions, HostApprovalReply, HostApprovalRequest,
        HostRunStatus,
    },
    tool::{
        browser::BrowserAccessDecision,
        ui::{
            BrowserCapabilityDecision, UiConfig,
            broker::{ConnectionConfig, UiBroker},
            wire,
        },
    },
};
use serde_json::json;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

#[derive(Default)]
struct PeerState {
    navigated: bool,
    grants: usize,
}

fn peer(broker: &UiBroker, state: Arc<Mutex<PeerState>>) -> std::thread::JoinHandle<()> {
    let config: ConnectionConfig =
        serde_json::from_slice(&std::fs::read(broker.configuration_path()).unwrap()).unwrap();
    std::thread::spawn(move || {
        let mut stream = std::os::unix::net::UnixStream::connect(config.socket).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        wire::write_message(&mut stream, &json!({"type":"hello","version":1,"backend":"chrome","token":config.token,"name":"权限测试浏览器"})).unwrap();
        let welcome = wire::read_message(&mut stream).unwrap();
        let session = welcome["sessions"]
            .as_object()
            .unwrap()
            .keys()
            .next()
            .unwrap()
            .clone();
        let page = format!("{}:1", welcome["connection"].as_str().unwrap());
        let tabs = json!([{"id":page,"url":"https://example.com/","title":"真实测试页","crashed":false,"dialog":null,"file_chooser":false}]);
        wire::write_message(
            &mut stream,
            &json!({"type":"share","session":session,"tabs":tabs}),
        )
        .unwrap();
        loop {
            let frame = wire::read_message(&mut stream).unwrap();
            if frame["type"] == "release" {
                if frame.get("id").is_some() {
                    wire::write_message(&mut stream, &json!({"type":"result","id":frame["id"],"value":{"outcome":"executed","mode":"human"}})).unwrap();
                }
                break;
            }
            if frame["type"] != "call" {
                continue;
            }
            let mut state = state.lock().unwrap();
            let action = frame["action"]["action"].as_str().unwrap();
            let value = match action {
                "tabs" => json!({"outcome":"observed","mode":"agent","tabs":tabs}),
                "extension_state" => {
                    json!({"outcome":"observed","mode":"agent","tabs":tabs,"extensions":{
                        "document":if state.navigated {"document-two"} else {"document-one"},
                        "origin":"https://example.com","revision":"directory-one",
                        "capabilities":[{"name":"developer_logs","granted":false,"permission":"current_document_session"}]
                    }})
                }
                "grant_capability" => {
                    assert_eq!(frame["action"]["document"], "document-one");
                    if state.navigated {
                        json!({"outcome":"not_executed","mode":"agent","tabs":tabs,"error":"审批期间页面已变化"})
                    } else {
                        state.grants += 1;
                        json!({"outcome":"executed","mode":"agent","tabs":tabs,"extensions":{"granted":true}})
                    }
                }
                other => panic!("意外后端动作：{other}"),
            };
            wire::write_message(
                &mut stream,
                &json!({"type":"result","id":frame["id"],"value":value}),
            )
            .unwrap();
        }
    })
}

enum Decision {
    Allow,
    Cancel,
    Navigate,
}

async fn run(decision: Decision) {
    let root = tempfile::tempdir().unwrap();
    let broker = UiBroker::open(root.path().join("ui"), "a".repeat(32), Arc::new(|| {})).unwrap();
    let code = "const b = await browser.get('chrome'); const page = b.state.tabs[0].id; print(JSON.parse(await __rpc(JSON.stringify({domain:'browser',backend:'chrome',action:{action:'request_capability',page,capability:'developer_logs',reason:'读取当前页错误'}}))));";
    let model = Arc::new(model::ScriptedModel::new(vec![
        vec![model::calls(&[(
            "capability",
            "ui_repl",
            json!({"type":"run","code":code,"timeout_ms":10000}),
        )])],
        vec![model::answer("权限请求已结算")],
    ]));
    let mut options = DesktopSessionOptions::new(root.path());
    options.ui = Some(UiConfig {
        executable: env!("CARGO_BIN_EXE_noemori-ui-runtime").into(),
        broker: broker.clone(),
        computer_helper: None,
        workspace: root.path().into(),
    });
    let host = DesktopSession::new(model, options, Arc::new(|| {})).unwrap();
    let state = Arc::new(Mutex::new(PeerState::default()));
    let peer = peer(&broker, state.clone());
    wait(&host, |snapshot| {
        snapshot
            .ui
            .connections
            .iter()
            .any(|connection| !connection.tabs.is_empty())
    })
    .await;
    host.start("读取当前测试页错误".into()).unwrap();
    let pending = wait(&host, |snapshot| !snapshot.approvals.is_empty()).await;
    let approval = &pending.approvals[0];
    let HostApprovalRequest::BrowserCapability(request) = &approval.request else {
        panic!("能力请求必须使用独立审批类型")
    };
    assert_eq!(request.origin, "https://example.com");
    assert_eq!(request.title, "真实测试页");
    assert_eq!(request.document, "document-one");
    assert_eq!(state.lock().unwrap().grants, 0);
    assert!(
        host.resolve_approval(
            &approval.id,
            HostApprovalReply::Browser(BrowserAccessDecision::AllowForSession)
        )
        .is_err()
    );
    assert_eq!(
        host.snapshot().approvals[0].id,
        approval.id,
        "错误类型不得消费待审批请求"
    );
    if matches!(decision, Decision::Cancel) {
        host.cancel();
        wait(&host, |snapshot| {
            snapshot
                .run
                .as_ref()
                .is_some_and(|run| run.status == HostRunStatus::Cancelled)
        })
        .await;
        assert!(
            host.resolve_approval(
                &approval.id,
                HostApprovalReply::BrowserCapability(BrowserCapabilityDecision::AllowForSession)
            )
            .is_err()
        );
    } else {
        if matches!(decision, Decision::Navigate) {
            state.lock().unwrap().navigated = true;
        }
        host.resolve_approval(
            &approval.id,
            HostApprovalReply::BrowserCapability(BrowserCapabilityDecision::AllowForSession),
        )
        .unwrap();
        wait(&host, |snapshot| {
            snapshot
                .run
                .as_ref()
                .is_some_and(|run| run.status == HostRunStatus::Completed)
        })
        .await;
    }
    assert!(host.snapshot().approvals.is_empty());
    assert_eq!(
        state.lock().unwrap().grants,
        usize::from(matches!(decision, Decision::Allow))
    );
    host.close().await.unwrap();
    peer.join().unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn capability_consent_uses_current_page_and_rejects_network_decisions() {
    run(Decision::Allow).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn cancelled_capability_consent_cannot_grant_later() {
    run(Decision::Cancel).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn navigation_during_capability_consent_does_not_grant_the_new_page() {
    run(Decision::Navigate).await;
}
