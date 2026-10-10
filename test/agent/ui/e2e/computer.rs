#![cfg(target_os = "macos")]

use noemori_agent::{CancellationToken, ExecutionContext, tool::ui::broker::UiBroker};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Arc,
    time::Duration,
};

const LAUNCH_SERVICES_REGISTER: &str = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

/// 回收独立测试应用和安装索引；失败时同样请求退出，不触碰用户的应用进程。
struct WindowFixture {
    root: tempfile::TempDir,
    installation: tempfile::TempDir,
}
impl Drop for WindowFixture {
    fn drop(&mut self) {
        let pid = std::fs::read(self.root.path().join("state.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|value| value["pid"].as_i64());
        let _ = std::fs::write(self.root.path().join("control"), "quit");
        for _ in 0..100 {
            let running = match pid {
                Some(pid) => Command::new("/bin/kill")
                    .args(["-0", &pid.to_string()])
                    .stderr(Stdio::null())
                    .status()
                    .is_ok_and(|status| status.success()),
                None => self.root.path().join("control").exists(),
            };
            if !running {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let bundle = self.installation.path().join("ComputerWindow.app");
        if bundle.exists() {
            match Command::new(LAUNCH_SERVICES_REGISTER)
                .arg("-u")
                .arg(bundle)
                .status()
            {
                Ok(status) if status.success() => {}
                result => eprintln!("独立测试应用注销失败：{result:?}"),
            }
        }
    }
}

/// 在用户应用目录构建真实 AppKit 夹具；系统临时目录会被安装索引标记为禁止启动。
fn build_window(root: &Path, installation: &Path) -> PathBuf {
    let bundle = installation.join("ComputerWindow.app");
    let contents = bundle.join("Contents");
    std::fs::create_dir_all(contents.join("MacOS")).unwrap();
    let source = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/agent/ui/support/ComputerWindow.swift");
    assert!(
        Command::new("xcrun")
            .args(["swiftc", "-framework", "AppKit"])
            .arg(source)
            .arg("-o")
            .arg(contents.join("MacOS/ComputerWindow"))
            .status()
            .unwrap()
            .success()
    );
    std::fs::write(
        contents.join("Info.plist"),
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>org.noemori.test.computer-window</string>
<key>CFBundleName</key><string>Computer Window Test</string>
<key>CFBundleExecutable</key><string>ComputerWindow</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>NSPrincipalClass</key><string>TestApplication</string>
<key>NoemoriFixtureRoot</key><string>{}</string>
</dict></plist>"#,
            root.display()
        ),
    )
    .unwrap();
    assert!(
        Command::new("codesign")
            .args(["--force", "--sign", "-"])
            .arg(&bundle)
            .status()
            .unwrap()
            .success()
    );
    // 按路径打开不会保证安装索引可按 bundle ID 解析；使用正常注册流程验收生产契约。
    assert!(
        Command::new(LAUNCH_SERVICES_REGISTER)
            .arg("-f")
            .arg(&bundle)
            .status()
            .unwrap()
            .success()
    );
    bundle
}

async fn state(root: &Path, accept: impl Fn(&Value) -> bool) -> Value {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Ok(bytes) = std::fs::read(root.join("state.json")) {
                let value: Value = serde_json::from_slice(&bytes).unwrap();
                if accept(&value) {
                    return value;
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap_or_else(|_| {
        let received = std::fs::read_to_string(root.join("state.json"))
            .unwrap_or_else(|error| format!("窗口回执不可读：{error}"));
        panic!("独立窗口没有收到预期的真实事件；最后回执：{received}")
    })
}

async fn action(broker: &UiBroker, command: Value) -> Value {
    let context = ExecutionContext::new(CancellationToken::new(), Duration::from_secs(15)).unwrap();
    broker
        .execute("computer-e2e", "computer", command.clone(), &context)
        .await
        .unwrap_or_else(|error| panic!("原生动作 {command} 未确认完成：{error}"))
}

/// 仅显式运行，且必须先由用户为具体 Helper 授予辅助功能和屏幕录制权限。
#[tokio::test(flavor = "multi_thread")]
#[ignore = "需要用户批准 macOS 辅助功能和屏幕录制；只操作独立测试窗口"]
async fn real_background_window_accepts_human_input_and_rejects_stale_frames() {
    exercise_background_window(false, false).await;
    for stage_managed in [false, true] {
        exercise_background_window(stage_managed, true).await;
    }
}

async fn exercise_background_window(stage_managed: bool, menu_target: bool) {
    let applications = PathBuf::from(std::env::var_os("HOME").unwrap()).join("Applications");
    let fixture = WindowFixture {
        root: tempfile::tempdir().unwrap(),
        installation: tempfile::Builder::new()
            .prefix("NoemoriComputerTest-")
            .tempdir_in(applications)
            .unwrap(),
    };
    let broker = UiBroker::open(
        fixture.root.path().join("broker"),
        "adeahajhgekfhfgimpaokoahfajebajb".into(),
        Arc::new(|| {}),
    )
    .unwrap();
    broker.register("computer-e2e", "独立原生窗口验收");
    // 验收使用应用随包的已签名版本，并冻结副本；开发构建不能在授权后替换被测签名。
    let bundled = std::env::var_os("NOEMORI_COMPUTER_TEST_HELPER")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../notes/packages/desktop/out/main/agent/NoemoriComputerHelper.app")
        });
    let helper = fixture.root.path().join("NoemoriComputerHelper.app");
    assert!(
        Command::new("/usr/bin/ditto")
            .arg(bundled)
            .arg(&helper)
            .status()
            .unwrap()
            .success()
    );
    assert!(
        Command::new("/usr/bin/codesign")
            .args(["--verify", "--strict"])
            .arg(&helper)
            .status()
            .unwrap()
            .success()
    );
    let context = ExecutionContext::new(CancellationToken::new(), Duration::from_secs(15)).unwrap();
    broker.ensure_computer(&helper, &context).await.unwrap();
    let permissions = action(&broker, json!({"action":"permissions"})).await;
    assert_eq!(
        permissions["accessibility"], true,
        "请先批准具体 Helper 的辅助功能权限"
    );
    assert_eq!(
        permissions["screen_recording"], true,
        "请先批准具体 Helper 的屏幕录制权限"
    );
    let bundle = build_window(fixture.root.path(), fixture.installation.path());
    let mut launch = Command::new("/usr/bin/open");
    launch.args(["-g", "-n", "-a"]).arg(bundle).arg("--args");
    if stage_managed {
        launch.arg("--stage-managed");
    }
    if !menu_target {
        launch.arg("--unrouted-menu");
    }
    assert!(launch.arg(fixture.root.path()).status().unwrap().success());
    let initial = state(fixture.root.path(), |value| {
        if stage_managed {
            return true;
        }
        value["cg_windows"].as_array().is_some_and(|windows| {
            windows.iter().any(|window| {
                let bounds = &window["kCGWindowBounds"];
                window["kCGWindowNumber"] == value["window_number"]
                    && [
                        ("X", "x"),
                        ("Y", "y"),
                        ("Width", "width"),
                        ("Height", "height"),
                    ]
                    .iter()
                    .all(|(cg, native)| bounds[cg] == value["native_frame"][native])
            })
        })
    })
    .await;
    assert_eq!(initial["application_class"], "TestApplication");
    if !stage_managed && menu_target {
        exercise_launch(
            &broker,
            fixture.root.path(),
            initial["pid"].as_i64().unwrap(),
        )
        .await;
    }
    let initial = state(fixture.root.path(), |_| true).await;
    assert_eq!(initial["menu_editor_target"], menu_target);
    let apps = action(&broker, json!({"action":"apps"})).await;
    assert_eq!(apps["outcome"], "observed", "{apps}");
    let target = apps["apps"]
        .as_array()
        .unwrap()
        .iter()
        .find(|app| app["pid"] == initial["pid"])
        .unwrap();
    assert_eq!(target["active"], false, "验收应用必须保持后台");
    let app = target["id"].as_str().unwrap();
    let listed = action(&broker, json!({"action":"windows","app":app})).await;
    assert_eq!(listed["outcome"], "observed", "{listed}");
    let windows: Vec<_> = listed["windows"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|window| window["title"] == "Computer use 独立验收")
        .collect();
    assert_eq!(windows.len(), 1, "验收窗口必须唯一：{listed}");
    let window = windows[0]["id"].as_str().unwrap();
    if !menu_target {
        exercise_unrouted_paste(&broker, fixture.root.path(), app, window).await;
        broker.release_confirmed("computer-e2e").await.unwrap();
        return;
    }
    std::fs::write(fixture.root.path().join("control"), "twin").unwrap();
    state(fixture.root.path(), |value| {
        value["twin_window"].as_i64().unwrap() > 0
    })
    .await;
    assert_eq!(
        action(
            &broker,
            json!({"action":"grant_control","app":app,"window":window})
        )
        .await["outcome"],
        "executed"
    );
    let screenshot = action(
        &broker,
        json!({"action":"screenshot","app":app,"window":window}),
    )
    .await;
    assert_eq!(
        screenshot["outcome"], "observed",
        "{screenshot}；AX 窗口：{listed}；实际窗口：{initial}"
    );
    assert!(!screenshot["image_data"].as_str().unwrap().is_empty());
    assert_eq!(
        screenshot["mapping"]["window_id"], initial["window_number"],
        "同标题、同范围窗口必须按真实身份关联"
    );
    let mapping = &screenshot["mapping"];
    let point = |name: &str| {
        let value = &initial["points"][name];
        let bounds = &mapping["screen_bounds"];
        let x = (value["x"].as_f64().unwrap() - bounds["x"].as_f64().unwrap())
            * mapping["width"].as_f64().unwrap()
            / bounds["width"].as_f64().unwrap();
        let y = (value["y"].as_f64().unwrap() - bounds["y"].as_f64().unwrap())
            * mapping["height"].as_f64().unwrap()
            / bounds["height"].as_f64().unwrap();
        (x, y)
    };
    assert_eq!(
        action(&broker, json!({"action":"handoff"})).await["outcome"],
        "executed"
    );
    let preview = action(
        &broker,
        json!({"action":"preview","app":app,"window":window}),
    )
    .await;
    let token = preview["input_token"].as_str().unwrap();
    let send = |input| json!({"action":"human_input","app":app,"window":window,"token":token,"input":input});
    let (x, y) = point("click");
    for clicks in [1, 2] {
        let result = action(
            &broker,
            send(json!({"type":"pointer","x":x,"y":y,"clicks":clicks})),
        )
        .await;
        assert_eq!(
            result["outcome"],
            "executed",
            "{result}；真实窗口：{}",
            state(fixture.root.path(), |_| true).await
        );
    }
    let received = state(fixture.root.path(), |value| value["releases"] == 2).await;
    assert_eq!(
        received["clicks"],
        json!([1, 2]),
        "双击必须只有两对真实事件"
    );
    assert_eq!(
        received["twin_clicks"],
        json!([]),
        "后台点击不得发送给重叠的同名窗口"
    );
    for event in received["pointer_events"].as_array().unwrap() {
        assert_eq!(event["window"], initial["window_number"]);
        let expected_x = initial["points"]["click"]["x"].as_f64().unwrap()
            - initial["native_frame"]["x"].as_f64().unwrap();
        let expected_y = initial["native_frame"]["height"].as_f64().unwrap()
            - (initial["points"]["click"]["y"].as_f64().unwrap()
                - initial["native_frame"]["y"].as_f64().unwrap());
        assert!(
            (event["x"].as_f64().unwrap() - expected_x).abs() < 0.01,
            "横向点击坐标错误：{event}"
        );
        assert!(
            (event["y"].as_f64().unwrap() - expected_y).abs() < 0.01,
            "纵向点击坐标错误：{event}"
        );
    }
    let (button_x, button_y) = point("button");
    assert_eq!(
        action(
            &broker,
            send(json!({"type":"pointer","x":button_x,"y":button_y}))
        )
        .await["outcome"],
        "executed"
    );
    state(fixture.root.path(), |value| value["button_clicks"] == 1).await;
    let (x, y) = point("text");
    assert_eq!(
        action(&broker, send(json!({"type":"pointer","x":x,"y":y}))).await["outcome"],
        "executed"
    );
    for (input, expected) in [
        (
            json!({"type":"text","text":"中文验收🧠"}),
            Some("中文验收🧠"),
        ),
        (json!({"type":"key","key":"End"}), None),
        (
            json!({"type":"text","text":"粘贴内容"}),
            Some("中文验收🧠粘贴内容"),
        ),
    ] {
        let result = action(&broker, send(input.clone())).await;
        assert_eq!(
            result["outcome"],
            "executed",
            "{input}：{result}；实际窗口：{}",
            state(fixture.root.path(), |_| true).await
        );
        if let Some(expected) = expected {
            state(fixture.root.path(), |value| value["text"] == expected).await;
        }
    }
    state(fixture.root.path(), |value| {
        value["text"] == "中文验收🧠粘贴内容"
    })
    .await;
    let (at_x, at_y) = point("scroll");
    let result = action(
        &broker,
        send(json!({"type":"scroll","x":0,"y":100,"at_x":at_x,"at_y":at_y})),
    )
    .await;
    assert_eq!(result["outcome"], "executed", "{result}");
    state(fixture.root.path(), |value| {
        value["scrolls"].as_u64().unwrap() > 0
    })
    .await;
    let (at_x, at_y) = point("viewport");
    assert_eq!(
        action(
            &broker,
            send(json!({"type":"scroll","x":0,"y":100,"at_x":at_x,"at_y":at_y}))
        )
        .await["outcome"],
        "executed"
    );
    state(fixture.root.path(), |value| {
        value["scroll_position"].as_f64().unwrap() > initial["scroll_position"].as_f64().unwrap()
    })
    .await;
    let (from_x, from_y) = point("from");
    let (to_x, to_y) = point("to");
    let result = action(
        &broker,
        send(json!({"type":"drag","from_x":from_x,"from_y":from_y,"to_x":to_x,"to_y":to_y})),
    )
    .await;
    assert_eq!(result["outcome"], "executed", "{result}");
    state(fixture.root.path(), |value| {
        value["drags"].as_u64().unwrap() > 0
    })
    .await;
    std::fs::write(fixture.root.path().join("control"), "move").unwrap();
    state(fixture.root.path(), |value| {
        value["points"]["click"]["x"] != initial["points"]["click"]["x"]
    })
    .await;
    let rejected = action(&broker, send(json!({"type":"pointer","x":x,"y":y}))).await;
    assert_eq!(
        rejected["outcome"], "not_executed",
        "旧画面凭据不得穿过窗口移动：{rejected}"
    );
    let next = action(
        &broker,
        json!({"action":"preview","app":app,"window":window}),
    )
    .await;
    assert_ne!(next["input_token"], preview["input_token"]);
    let apps = action(&broker, json!({"action":"apps"})).await;
    assert_eq!(
        apps["apps"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == app)
            .unwrap()["active"],
        false,
        "输入不能抢占用户焦点"
    );
    exercise_text_interaction(&broker, fixture.root.path(), app, window).await;
    assert_eq!(
        state(fixture.root.path(), |_| true).await["active"],
        false,
        "文本、快捷键和延迟粘贴同样不得激活目标应用"
    );
    std::fs::write(fixture.root.path().join("control"), "hide").unwrap();
    state(fixture.root.path(), |value| {
        value["window_visible"] == false && value["ax_window_count"] == 0
    })
    .await;
    let empty = action(&broker, json!({"action":"windows","app":app})).await;
    assert_eq!(empty["outcome"], "observed", "{empty}");
    assert_eq!(
        empty["windows"],
        json!([]),
        "隐藏全部实际窗口后应返回空数组"
    );
    broker.release_confirmed("computer-e2e").await.unwrap();
}

/// 默认菜单响应链没有后台目标时只能报告待确认；目标真实退出后才安全恢复剪贴板。
async fn exercise_unrouted_paste(broker: &UiBroker, root: &Path, app: &str, window: &str) {
    let observed = action(
        broker,
        json!({"action":"grant_control","app":app,"window":window}),
    )
    .await;
    let observed = action(
        broker,
        text_action(
            app,
            window,
            &observed,
            "set_value",
            json!({"value":"菜单未消费"}),
        ),
    )
    .await;
    assert_eq!(observed["outcome"], "executed", "{observed}");
    let pending = action(
        broker,
        text_action(app, window, &observed, "paste", json!({"text":"不应插入"})),
    )
    .await;
    assert_eq!(pending["outcome"], "unknown", "{pending}");
    assert_eq!(pending["clipboard_pending"], true);
    let actual = state(root, |_| true).await;
    assert_eq!(actual["text"], "菜单未消费");
    assert_eq!(actual["paste_requests"], 0);
    assert_eq!(actual["active"], false);
    assert_eq!(actual["key_window"], 0);
    assert_eq!(actual["paste_target"], "");
    assert_eq!(actual["menu_editor_target"], false);
    assert!(
        actual["window_first_responder"]
            .as_str()
            .unwrap()
            .ends_with(".TextEditor")
    );
    let blocked = action(
        broker,
        text_action(app, window, &observed, "paste", json!({"text":"不应重放"})),
    )
    .await;
    assert_eq!(blocked["outcome"], "not_executed", "{blocked}");
    assert_eq!(state(root, |_| true).await["paste_requests"], 0);
    std::fs::write(root.join("control"), "quit").unwrap();
    let settled = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let permissions = action(broker, json!({"action":"permissions"})).await;
            if permissions["clipboard_pending"] == false {
                break permissions;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        settled["clipboard_settlement"]["token"],
        pending["clipboard_token"]
    );
    assert_eq!(settled["clipboard_settlement"]["reason"], "target_exited");
    assert_eq!(settled["clipboard_settlement"]["clipboard_restored"], true);
    assert_eq!(settled["clipboard_settlement"]["acknowledged"], false);
    let final_state = state(root, |_| true).await;
    let events = final_state["keyboard_events"].as_array().unwrap();
    assert_eq!(events.len(), 2, "待确认后不得再次投递按键：{events:?}");
    for (event, kind) in events.iter().zip([10, 11]) {
        assert_eq!(event["type"], kind);
        assert_eq!(event["window"], final_state["window_number"]);
        assert_eq!(event["key_code"], 9);
        assert_eq!(event["flags"], 1 << 20);
        assert_eq!(event["characters"], "v");
    }
}

/// 新启动只操作已注册的独立测试 bundle，前台与启动实例由真实系统回执核验。
async fn exercise_launch(broker: &UiBroker, root: &Path, before: i64) {
    let bundle = "org.noemori.test.computer-window";
    let info = action(broker, json!({"action":"launch_info","bundle_id":bundle})).await;
    assert_eq!(info["outcome"], "observed", "{info}");
    assert_eq!(info["bundle_id"], bundle);
    assert_eq!(info["app_name"], "Computer Window Test");
    std::fs::write(root.join("control"), "quit").unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let apps = action(broker, json!({"action":"apps"})).await;
            assert_eq!(apps["outcome"], "observed", "{apps}");
            if !apps["apps"]
                .as_array()
                .unwrap()
                .iter()
                .any(|app| app["pid"] == before)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    })
    .await
    .unwrap();
    let launched = action(broker, json!({"action":"launch_app","bundle_id":bundle})).await;
    assert_eq!(launched["outcome"], "executed", "{launched}");
    assert_eq!(launched["background"], true);
    assert_eq!(launched["bundle_id"], bundle);
    let next = state(root, |value| value["pid"] != before).await;
    assert_eq!(next["active"], false, "后台启动不应激活测试应用");
}

/// 文本动作只使用实际观察给出的 AXTextArea；缺失或多个编辑器均拒绝猜测引用。
fn text_action(app: &str, window: &str, observed: &Value, name: &str, fields: Value) -> Value {
    let refs: Vec<_> = observed["observation"]["elements"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|element| element["role"] == "AXTextArea")
        .collect();
    assert_eq!(refs.len(), 1, "测试编辑器必须唯一：{observed}");
    let mut result = json!({"action":name,"app":app,"window":window,"observation":observed["observation"]["id"],"ref":refs[0]["ref"]});
    result
        .as_object_mut()
        .unwrap()
        .extend(fields.as_object().unwrap().clone());
    result
}

/// 富文本必须覆盖目标文字的每个 UTF-16 位置；纯文本回显不能证明格式已被消费。
fn assert_bold_text(state: &Value, text: &str) {
    let actual = state["text"].as_str().unwrap();
    let start = actual[..actual.find(text).unwrap()].encode_utf16().count();
    let end = start + text.encode_utf16().count();
    let runs = state["font_runs"].as_array().unwrap();
    for position in start..end {
        assert!(
            runs.iter().any(|run| {
                let location = run["location"].as_u64().unwrap() as usize;
                let length = run["length"].as_u64().unwrap() as usize;
                run["bold"] == true && position >= location && position < location + length
            }),
            "目标文字 {text:?} 在 UTF-16 位置 {position} 未收到粗体：{state}"
        );
    }
}

/// 真实 TextView 接收选区和三种粘贴格式，旧引用及撤销后的窗口许可明确拒绝。
async fn exercise_text_interaction(broker: &UiBroker, root: &Path, app: &str, window: &str) {
    let observed = action(
        broker,
        json!({"action":"grant_control","app":app,"window":window}),
    )
    .await;
    let delta = action(broker, json!({"action":"observe","app":app,"window":window,"mode":"delta","baseline":observed["observation"]["id"]})).await;
    assert_eq!(delta["observation_update"]["kind"], "unchanged", "{delta}");
    assert_ne!(
        delta["observation_update"]["id"],
        observed["observation"]["id"]
    );
    let stale = action(
        broker,
        text_action(
            app,
            window,
            &observed,
            "set_value",
            json!({"value":"旧观察不应生效"}),
        ),
    )
    .await;
    assert_eq!(stale["outcome"], "not_executed");
    let observed = action(
        broker,
        json!({"action":"observe","app":app,"window":window}),
    )
    .await;
    let none = action(
        broker,
        text_action(
            app,
            window,
            &observed,
            "set_value",
            json!({"value":"完整读取前的值","observation_mode":"none"}),
        ),
    )
    .await;
    assert_eq!(none["outcome"], "executed", "{none}");
    assert!(none.get("observation").is_none() && none.get("observation_update").is_none());
    let stale = action(
        broker,
        text_action(
            app,
            window,
            &observed,
            "set_value",
            json!({"value":"旧观察不应生效"}),
        ),
    )
    .await;
    assert_eq!(stale["outcome"], "not_executed");
    let observed = action(broker, json!({"action":"observe","app":app,"window":window,"mode":"delta","baseline":observed["observation"]["id"]})).await;
    assert!(observed.get("observation").is_some(), "{observed}");
    assert_eq!(
        observed["observation_update"]["reset_reason"], "invalidated",
        "{observed}"
    );
    let prefix = "前".repeat(1500);
    let long_text = format!("{prefix}TAIL");
    let long_observed = action(
        broker,
        text_action(
            app,
            window,
            &observed,
            "set_value",
            json!({"value":long_text}),
        ),
    )
    .await;
    assert_eq!(long_observed["outcome"], "executed", "{long_observed}");
    let long_selected = action(
        broker,
        text_action(
            app,
            window,
            &long_observed,
            "select_text",
            json!({"text":"TAIL"}),
        ),
    )
    .await;
    assert_eq!(long_selected["outcome"], "executed", "{long_selected}");
    assert_eq!(
        long_selected["text_interaction"]["selection"],
        json!({"location":1500,"length":4})
    );
    let long_pasted = action(
        broker,
        text_action(
            app,
            window,
            &long_selected,
            "paste",
            json!({"text":"替换🙂"}),
        ),
    )
    .await;
    assert_eq!(
        long_pasted["outcome"],
        "executed",
        "{long_pasted}；实际窗口：{}",
        state(root, |_| true).await
    );
    assert_eq!(long_pasted["text_interaction"]["clipboard_restored"], true);
    let expected = format!("{prefix}替换🙂");
    state(root, |value| value["text"] == expected).await;
    let observed = action(
        broker,
        text_action(
            app,
            window,
            &long_pasted,
            "set_value",
            json!({"value":"甲名字乙 甲名字丙"}),
        ),
    )
    .await;
    assert_eq!(observed["outcome"], "executed", "{observed}");
    let ambiguous = action(
        broker,
        text_action(
            app,
            window,
            &observed,
            "select_text",
            json!({"text":"名字"}),
        ),
    )
    .await;
    assert_eq!(ambiguous["outcome"], "not_executed");
    let selected = action(
        broker,
        text_action(
            app,
            window,
            &observed,
            "select_text",
            json!({"text":"名字","prefix":"甲","suffix":"丙"}),
        ),
    )
    .await;
    assert_eq!(selected["outcome"], "executed", "{selected}");
    assert_eq!(
        selected["text_interaction"]["selection"],
        json!({"location":6,"length":2})
    );
    state(root, |value| {
        value["selection"] == json!({"location":6,"length":2})
    })
    .await;
    let pasted = action(
        broker,
        text_action(app, window, &selected, "paste", json!({"text":"新🙂"})),
    )
    .await;
    assert_eq!(pasted["outcome"], "executed", "{pasted}");
    assert_eq!(pasted["text_interaction"]["clipboard_restored"], true);
    state(root, |value| value["text"] == "甲名字乙 甲新🙂丙").await;
    let stale = action(
        broker,
        text_action(app, window, &selected, "paste", json!({"text":"错误"})),
    )
    .await;
    assert_eq!(stale["outcome"], "not_executed");
    let caret = action(
        broker,
        text_action(
            app,
            window,
            &pasted,
            "select_text",
            json!({"text":"新🙂","position":"after"}),
        ),
    )
    .await;
    assert_eq!(caret["outcome"], "executed", "{caret}");
    // 裸 Unicode HTML 由 public.html 的传输编码自描述，不要求调用者改写标记加入 charset。
    let rich = action(
        broker,
        text_action(
            app,
            window,
            &caret,
            "paste",
            json!({"text":"富文本","html":"<b>富文本</b>"}),
        ),
    )
    .await;
    assert_eq!(
        rich["outcome"],
        "executed",
        "{rich}；实际窗口：{}",
        state(root, |_| true).await
    );
    let formatted = state(root, |value| value["text"] == "甲名字乙 甲新🙂富文本丙").await;
    assert_bold_text(&formatted, "富文本");
    let caret = action(
        broker,
        text_action(
            app,
            window,
            &rich,
            "select_text",
            json!({"text":"富文本","position":"after"}),
        ),
    )
    .await;
    let rtf = action(
        broker,
        text_action(
            app,
            window,
            &caret,
            "paste",
            json!({"text":"RTF","rtf":"{\\rtf1\\ansi{\\fonttbl{\\f0 Helvetica;}}\\f0\\b RTF\\b0}"}),
        ),
    )
    .await;
    assert_eq!(rtf["outcome"], "executed", "{rtf}");
    let formatted = state(root, |value| value["text"] == "甲名字乙 甲新🙂富文本RTF丙").await;
    assert_bold_text(&formatted, "RTF");
    let caret = action(
        broker,
        text_action(
            app,
            window,
            &rtf,
            "select_text",
            json!({"text":"RTF","position":"after"}),
        ),
    )
    .await;
    std::fs::write(root.join("control"), "delay_paste").unwrap();
    let before = state(root, |value| value["paste_delay"] == 6).await;
    let delayed = action(
        broker,
        text_action(app, window, &caret, "paste", json!({"text":"延迟"})),
    )
    .await;
    assert_eq!(delayed["outcome"], "unknown", "{delayed}");
    assert_eq!(delayed["clipboard_pending"], true);
    let blocked = action(
        broker,
        text_action(app, window, &caret, "paste", json!({"text":"不应重放"})),
    )
    .await;
    assert_eq!(blocked["outcome"], "not_executed");
    let after = state(root, |value| {
        value["text"] == "甲名字乙 甲新🙂富文本RTF延迟丙"
    })
    .await;
    assert_eq!(
        after["paste_requests"].as_u64().unwrap(),
        before["paste_requests"].as_u64().unwrap() + 1
    );
    let settled = action(broker, json!({"action":"permissions"})).await;
    assert_eq!(settled["clipboard_pending"], false, "{settled}");
    assert_eq!(
        settled["clipboard_settlement"]["token"],
        delayed["clipboard_token"]
    );
    assert_eq!(settled["clipboard_settlement"]["reason"], "acknowledged");
    assert_eq!(settled["clipboard_settlement"]["clipboard_restored"], true);
    action(broker, json!({"action":"handoff"})).await;
    let context = ExecutionContext::new(CancellationToken::new(), Duration::from_secs(15)).unwrap();
    match broker
        .execute(
            "computer-e2e",
            "computer",
            text_action(app, window, &rich, "paste", json!({"text":"未授权"})),
            &context,
        )
        .await
    {
        Ok(denied) => assert_eq!(denied["outcome"], "not_executed"),
        Err(error) => assert_eq!(error.outcome(), "not_executed"),
    }
}
