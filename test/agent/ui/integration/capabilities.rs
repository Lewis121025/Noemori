//! 真实 UiTool→BrowserTool→Chromium 验证审批阶段去重与 WebMCP 输入闭环，不访问用户网站。
use async_trait::async_trait;
use noemori_agent::{
    AgentSession, CancellationToken, ExecutionContext,
    tool::{
        Tool, ToolContext,
        browser::{BrowserConfig, BrowserTool},
        ui::{
            BrowserCapabilityApprover, BrowserCapabilityDecision, BrowserCapabilityRequest,
            UiConfig, UiInput, UiTool,
            broker::{ConnectionConfig, UiBroker},
            computer::{UiAccessDecision, UiAccessRequest, UiApprover},
            wire,
        },
    },
};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Default)]
struct Approver {
    requests: Mutex<Vec<BrowserCapabilityRequest>>,
}
#[async_trait]
impl BrowserCapabilityApprover for Approver {
    async fn approve(
        &self,
        request: BrowserCapabilityRequest,
        _: ExecutionContext,
    ) -> Result<BrowserCapabilityDecision, String> {
        self.requests.lock().unwrap().push(request);
        Ok(BrowserCapabilityDecision::AllowForSession)
    }
}

async fn site() -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut request = [0; 4096];
                if socket.read(&mut request).await.unwrap() == 0 {
                    return;
                }
                let html = r#"<!doctype html><title>原生能力测试</title><label>姓名<input></label><output>次数0</output><script>
                if (document.modelContext) document.modelContext.registerTool({name:'update',description:'更新隔离测试记录',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false},execute:async(input)=>{window.calls=(window.calls||0)+1;document.querySelector('output').textContent='次数'+window.calls+' '+input.text;return JSON.stringify({saved:input.text,calls:window.calls});},annotations:{readOnlyHint:true}});
                </script>"#;
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{html}",
                    html.len()
                );
                socket.write_all(response.as_bytes()).await.unwrap();
            });
        }
    });
    (origin, task)
}

async fn run(
    tool: &UiTool,
    session: &AgentSession,
    id: &str,
    code: String,
) -> noemori_agent::tool::ui::UiOutput {
    tool.execute(
        UiInput::Run {
            code,
            timeout_ms: 30000,
        },
        ToolContext {
            call_id: id.into(),
            session: session.clone(),
            execution: ExecutionContext::new(CancellationToken::new(), Duration::from_secs(30))
                .unwrap(),
        },
    )
    .await
    .unwrap()
}

fn browser_tool(workspace: &std::path::Path, origin: String) -> BrowserTool {
    BrowserTool::new(BrowserConfig {
        node: "node".into(),
        worker: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("web-runtime/dist/browser/main.js"),
        browser: std::env::var_os("NOEMORI_TEST_BROWSER").map(PathBuf::from),
        workspace: workspace.into(),
        headless: true,
        embedded_host: None,
        private_origins: vec![origin],
    })
    .unwrap()
}

#[tokio::test]
async fn managed_capability_and_schema_stages_do_not_reuse_parent_call_identity() {
    let workspace = tempfile::tempdir().unwrap();
    let (origin, site) = site().await;
    let browser = browser_tool(workspace.path(), origin.clone());
    let approver = Arc::new(Approver::default());
    let tool = UiTool::new(
        env!("CARGO_BIN_EXE_noemori-ui-runtime").into(),
        Some(browser),
    )
    .unwrap()
    .with_capability_approver(approver.clone());
    let session = AgentSession::new();
    let prepared = run(&tool, &session, "prepare-permission", format!("const b=await browser.get('managed');const p=await b.open({});print(await p.requestCapability('cdp','检查布局'));print(await p.cdp.send('Page.getLayoutMetrics',{{}}));print(await p.requestCapability('developer_logs','检查页面日志'));const tools=await p.webmcp.list();print(tools);print(await p.requestCapability('webmcp','更新隔离测试记录'));", serde_json::to_string(&origin).unwrap())).await;
    assert!(prepared.error.is_none(), "{prepared:?}");
    assert!(
        prepared.prints.iter().any(|value| {
            value["extensions"]["result"]["value"]["cssLayoutViewport"]["clientWidth"]
                .as_u64()
                .is_some()
        }),
        "{prepared:?}"
    );
    assert_eq!(approver.requests.lock().unwrap().len(), 3);
    let invalid = run(&tool, &session, "invalid-schema", "print(await p.webmcp.call(tools.extensions.directory,tools.extensions.tools[0].id,{text:123}));".into()).await;
    assert!(
        invalid
            .prints
            .iter()
            .any(|value| value["outcome"] == "not_executed"
                && value["error"]
                    .as_str()
                    .is_some_and(|error| error.contains("Schema"))),
        "{invalid:?}"
    );
    let before = run(
        &tool,
        &session,
        "before-valid",
        "print(await p.read());".into(),
    )
    .await;
    assert!(
        before.prints.iter().any(|value| value["text_page"]["text"]
            .as_str()
            .is_some_and(|text| text.contains("次数0"))),
        "{before:?}"
    );
    let valid = run(&tool, &session, "valid-schema", "print(await p.webmcp.call(tools.extensions.directory,tools.extensions.tools[0].id,{text:'真实输入'},{observation_mode:'none'}));print(await p.read());".into()).await;
    assert!(valid.error.is_none(), "{valid:?}");
    assert!(
        valid
            .prints
            .iter()
            .any(|value| value["extensions"]["result"]["value"]["calls"] == 1),
        "{valid:?}"
    );
    assert!(
        valid.prints.iter().any(|value| value["text_page"]["text"]
            .as_str()
            .is_some_and(|text| text.contains("次数1 真实输入"))),
        "{valid:?}"
    );
    let blocked = run(&tool, &session, "private-schema", "print(await b.action({action:'grant_capability',page:p.id,document:'fake',origin:'https://example.com',revision:'fake',capability:'cdp'}));".into()).await;
    assert!(
        blocked
            .prints
            .iter()
            .any(|value| value["outcome"] == "not_executed"
                && value["error"]
                    .as_str()
                    .is_some_and(|error| error.contains("Schema"))),
        "{blocked:?}"
    );
    session.close().await.unwrap();
    site.abort();
}

struct DenyNative;
#[async_trait]
impl UiApprover for DenyNative {
    async fn approve(
        &self,
        _: UiAccessRequest,
        _: ExecutionContext,
    ) -> Result<UiAccessDecision, String> {
        Ok(UiAccessDecision::Deny("测试不申请原生控制".into()))
    }
}

#[cfg(unix)]
fn native_peer(broker: &UiBroker) -> std::thread::JoinHandle<()> {
    let config: ConnectionConfig =
        serde_json::from_slice(&std::fs::read(broker.configuration_path()).unwrap()).unwrap();
    let mut stream = std::os::unix::net::UnixStream::connect(config.socket).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    wire::write_message(&mut stream, &serde_json::json!({"type":"hello","version":1,"backend":"computer","token":config.token,"name":"隔离原生协议夹具"})).unwrap();
    assert_eq!(wire::read_message(&mut stream).unwrap()["type"], "welcome");
    std::thread::spawn(move || {
        loop {
            let frame = wire::read_message(&mut stream).unwrap();
            if frame["type"] == "invalidate" {
                continue;
            }
            let release = frame["type"] == "release";
            if !release {
                assert_eq!(frame["action"]["action"], "ax_action");
            }
            wire::write_message(&mut stream, &serde_json::json!({"type":"result","id":frame["id"],"value":{"outcome":"executed","bundle_id":"com.google.Chrome"}})).unwrap();
            if release {
                break;
            }
        }
    })
}

#[cfg(unix)]
#[tokio::test]
async fn native_browser_effect_invalidates_then_allows_fresh_managed_observe_and_fill() {
    let workspace = tempfile::tempdir().unwrap();
    let (origin, site) = site().await;
    let session = AgentSession::new();
    let broker = UiBroker::open(
        workspace.path().join("private"),
        "a".repeat(32),
        Arc::new(|| {}),
    )
    .unwrap();
    broker.register(session.id(), "混合输入验证");
    let peer = native_peer(&broker);
    let executable: PathBuf = env!("CARGO_BIN_EXE_noemori-ui-runtime").into();
    let tool = UiTool::new(
        executable.clone(),
        Some(browser_tool(workspace.path(), origin.clone())),
    )
    .unwrap()
    .with_connections(
        UiConfig {
            executable,
            broker: broker.clone(),
            computer_helper: None,
            workspace: workspace.path().into(),
        },
        Arc::new(DenyNative),
    )
    .unwrap();
    let opened = run(&tool, &session, "mixed-open", format!("const b=await browser.get('managed');const p=await b.open({});print(await p.observe());", serde_json::to_string(&origin).unwrap())).await;
    assert!(opened.error.is_none(), "{opened:?}");
    broker.execute(session.id(), "computer", serde_json::json!({"action":"ax_action","app":"browser-app","window":"window","ref":"e","name":"AXPress","observation":"native-observation"}), &ExecutionContext::new(CancellationToken::new(), Duration::from_secs(5)).unwrap()).await.unwrap();
    let result = run(&tool, &session, "mixed-after-native", "const fresh=await p.observe();print(fresh);if(fresh.outcome==='observed'){const input=p.snapshot.elements.find(e=>e.description.includes('姓名')&&e.description.includes('input'));print(await p.fill(input.ref,'混合输入'));}".into()).await;
    session.close().await.unwrap();
    peer.join().unwrap();
    site.abort();
    assert!(result.error.is_none(), "{result:?}");
    assert!(
        result
            .prints
            .iter()
            .any(|value| value["outcome"] == "observed"),
        "{result:?}"
    );
    assert!(
        result
            .prints
            .iter()
            .any(|value| value["outcome"] == "executed"),
        "{result:?}"
    );
}
