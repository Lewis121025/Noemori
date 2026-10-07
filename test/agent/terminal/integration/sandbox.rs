#![cfg(any(target_os = "macos", target_os = "linux"))]

use noemori_agent::{
    AgentSession, CancellationToken, ExecutionContext, ToolCall, ToolResult,
    tool::{
        ToolRegistry,
        terminal::{NetworkAccess, SandboxConfig, SandboxMode, TerminalTool, WorkspaceAccess},
    },
};
use serde_json::{Value, json};
use std::{path::Path, time::Duration};

#[path = "environment.rs"]
mod environment_tests;

#[path = "approval.rs"]
mod approval_tests;

#[path = "network.rs"]
mod network_tests;

#[path = "listeners.rs"]
mod listener_tests;

#[cfg(target_os = "macos")]
#[path = "unix_sockets.rs"]
mod unix_socket_tests;

fn tools(workspace: &Path, config: SandboxConfig) -> ToolRegistry {
    let mut tools = ToolRegistry::new();
    tools
        .register(
            TerminalTool::configured(workspace, "/bin/sh", SandboxMode::Restricted(config))
                .unwrap(),
        )
        .unwrap();
    tools
}

fn sandbox_temporary_parent() -> std::path::PathBuf {
    #[cfg(target_os = "macos")]
    {
        "/private/tmp".into()
    }
    #[cfg(target_os = "linux")]
    {
        std::env::temp_dir()
    }
}

async fn call(tools: &ToolRegistry, session: &AgentSession, arguments: Value) -> ToolResult {
    tools
        .execute_in_session(
            &ToolCall {
                id: "sandbox".into(),
                name: "terminal".into(),
                arguments,
            },
            ExecutionContext::new(CancellationToken::new(), Duration::from_secs(15)).unwrap(),
            session,
        )
        .await
        .unwrap()
}

async fn exec(tools: &ToolRegistry, session: &AgentSession, command: &str, tty: bool) -> Value {
    let result = call(
        tools,
        session,
        json!({"action":"exec","cmd":command,"tty":tty,"yield_time_ms":5000}),
    )
    .await;
    assert!(!result.is_error, "{:?}", result.output);
    assert_eq!(result.output["status"], "exited", "{:?}", result.output);
    result.output
}

async fn ready(
    tools: &ToolRegistry,
    session: &AgentSession,
    mut result: Value,
    complete: impl Fn(&str) -> bool,
) -> Value {
    tokio::time::timeout(Duration::from_secs(5), async {
        let mut text = result["output"].as_str().unwrap().to_owned();
        while !complete(&text) {
            assert_eq!(result["status"], "running", "{result:?}");
            result = call(
                tools,
                session,
                json!({"action":"interact","session_id":result["session_id"],"yield_time_ms":100}),
            )
            .await
            .output;
            text.push_str(result["output"].as_str().unwrap());
        }
        result["output"] = Value::String(text);
        result
    })
    .await
    .expect("沙箱命令未在期限内就绪")
}

#[tokio::test]
async fn bundled_rg_searches_without_host_tools_and_preserves_search_exit_codes() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace with spaces");
    std::fs::create_dir(&workspace).unwrap();
    std::fs::create_dir(workspace.join(".git")).unwrap();
    std::fs::write(workspace.join(".gitignore"), "ignored.txt\n").unwrap();
    std::fs::write(workspace.join("note.txt"), "first\nneedle 中文\n").unwrap();
    std::fs::write(workspace.join("ignored.txt"), "needle ignored\n").unwrap();
    std::fs::write(workspace.join(".hidden"), "needle hidden\n").unwrap();
    std::fs::write(root.path().join("secret"), "outside-secret\n").unwrap();
    std::os::unix::fs::symlink(root.path().join("secret"), workspace.join("escape")).unwrap();
    let tools = tools(&workspace, SandboxConfig::default());
    let session = AgentSession::new();
    for tty in [false, true] {
        let version = exec(&tools, &session, "rg --version", tty).await;
        assert_eq!(version["exit_code"], 0, "{version:?}");
        assert!(
            version["output"]
                .as_str()
                .unwrap()
                .starts_with("ripgrep 15.2.0")
        );
        let found = exec(
            &tools,
            &session,
            "rg --color never --no-heading -n needle",
            tty,
        )
        .await;
        assert_eq!(found["exit_code"], 0, "{found:?}");
        assert_eq!(
            found["output"].as_str().unwrap().replace('\r', ""),
            "note.txt:2:needle 中文\n"
        );
        let absent = exec(&tools, &session, "rg missing note.txt", tty).await;
        assert_eq!(absent["exit_code"], 1, "{absent:?}");
        for command in [
            "rg '[' note.txt",
            "rg outside-secret ../secret",
            "rg outside-secret escape",
        ] {
            let failed = exec(&tools, &session, command, tty).await;
            assert_eq!(failed["exit_code"], 2, "{failed:?}");
            assert!(
                !failed["output"]
                    .as_str()
                    .unwrap()
                    .contains("outside-secret")
            );
        }
    }
    session.close().await.unwrap();
}

#[tokio::test]
async fn bundled_rg_cannot_be_replaced_even_when_workspace_contains_runtime_directory() {
    let workspace = sandbox_temporary_parent();
    let tools = tools(&workspace, SandboxConfig::default());
    let session = AgentSession::new();
    let located = exec(&tools, &session, "command -v rg", false).await;
    assert_eq!(located["exit_code"], 0, "{located:?}");
    let path = located["output"].as_str().unwrap().trim();
    assert!(
        path.starts_with(workspace.canonicalize().unwrap().to_str().unwrap()),
        "{path}"
    );
    for command in [
        "printf replaced > \"$(command -v rg)\"",
        "rm \"$(command -v rg)\"",
        "mv \"${PATH%%:*}\" \"$HOME/stolen\"",
    ] {
        let denied = exec(&tools, &session, command, false).await;
        assert_ne!(denied["exit_code"], 0, "{denied:?}");
    }
    let version = exec(&tools, &session, "rg --version", false).await;
    assert_eq!(version["exit_code"], 0, "{version:?}");
    session.close().await.unwrap();
}

#[tokio::test]
async fn unrestricted_terminal_also_prefers_bundled_rg() {
    let workspace = tempfile::tempdir().unwrap();
    let mut tools = ToolRegistry::new();
    tools
        .register(
            TerminalTool::configured(workspace.path(), "/bin/sh", SandboxMode::Disabled).unwrap(),
        )
        .unwrap();
    let session = AgentSession::new();
    let located = exec(&tools, &session, "command -v rg", false).await;
    assert_eq!(located["exit_code"], 0, "{located:?}");
    assert!(
        located["output"]
            .as_str()
            .unwrap()
            .contains("noemori-sandbox-"),
        "{located:?}"
    );
    let version = exec(&tools, &session, "rg --version", false).await;
    assert_eq!(version["exit_code"], 0, "{version:?}");
    session.close().await.unwrap();
}

#[tokio::test]
async fn read_only_workspace_allows_search_and_private_scratch_but_rejects_project_mutation() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("note.txt"), "original\n").unwrap();
    std::os::unix::fs::symlink(root.path().join("note.txt"), root.path().join("alias")).unwrap();
    let tools = tools(
        root.path(),
        SandboxConfig {
            workspace_access: WorkspaceAccess::ReadOnly,
            ..Default::default()
        },
    );
    let session = AgentSession::new();
    for tty in [false, true] {
        let found = exec(&tools, &session, "rg original note.txt", tty).await;
        assert_eq!(found["exit_code"], 0, "{found:?}");
        for command in [
            "printf changed > note.txt",
            "printf changed > alias",
            "touch created",
            "rm -f note.txt",
            "mv -f note.txt renamed",
        ] {
            let denied = exec(&tools, &session, command, tty).await;
            assert_ne!(denied["exit_code"], 0, "{denied:?}");
        }
        let scratch = exec(
            &tools,
            &session,
            "printf scratch > \"$HOME/test\"; cat \"$HOME/test\"",
            tty,
        )
        .await;
        assert_eq!(scratch["output"], "scratch");
    }
    assert_eq!(
        std::fs::read_to_string(root.path().join("note.txt")).unwrap(),
        "original\n"
    );
    session.close().await.unwrap();
}

#[tokio::test]
async fn default_sandbox_allows_workspace_and_denies_outside_reads_writes_and_symlinks() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("work");
    std::fs::create_dir(&workspace).unwrap();
    std::fs::write(root.path().join("secret"), "sandbox-external-secret").unwrap();
    std::os::unix::fs::symlink(root.path().join("secret"), workspace.join("escape")).unwrap();
    let tools = tools(&workspace, SandboxConfig::default());
    let session = AgentSession::new();
    for tty in [false, true] {
        let allowed = exec(
            &tools,
            &session,
            "printf inside > allowed; cat allowed",
            tty,
        )
        .await;
        assert_eq!(allowed["exit_code"], 0);
        assert_eq!(allowed["output"], "inside");
        for command in [
            "cat ../secret",
            "cat escape",
            "printf changed > ../secret",
            "printf changed > escape",
            "/bin/sh -c 'cat ../secret'",
        ] {
            let denied = exec(&tools, &session, command, tty).await;
            assert_ne!(denied["exit_code"], 0, "{denied:?}");
            assert!(
                !denied["output"]
                    .as_str()
                    .unwrap()
                    .contains("sandbox-external-secret")
            );
            assert!(!denied["output"].as_str().unwrap().is_empty());
        }
    }
    assert_eq!(
        std::fs::read_to_string(root.path().join("secret")).unwrap(),
        "sandbox-external-secret"
    );
    session.close().await.unwrap();
}

#[tokio::test]
async fn host_can_grant_read_and_write_paths_without_opening_sibling_files() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("work");
    let writable = root.path().join("granted");
    std::fs::create_dir(&workspace).unwrap();
    std::fs::create_dir(&writable).unwrap();
    let readable = root.path().join("readable");
    std::fs::write(&readable, "read-only").unwrap();
    let config = SandboxConfig {
        readable_paths: vec![readable.canonicalize().unwrap()],
        writable_paths: vec![writable.canonicalize().unwrap()],
        ..Default::default()
    };
    let tools = tools(&workspace, config);
    let session = AgentSession::new();
    let read = exec(&tools, &session, "cat ../readable", false).await;
    assert_eq!(read["output"], "read-only");
    let write = exec(&tools, &session, "printf changed > ../readable", false).await;
    assert_ne!(write["exit_code"], 0);
    let allowed = exec(
        &tools,
        &session,
        "printf granted > ../granted/result; cat ../granted/result",
        false,
    )
    .await;
    assert_eq!(allowed["output"], "granted");
    session.close().await.unwrap();
}

#[tokio::test]
async fn model_cannot_change_policy_or_reuse_a_process_with_different_permissions() {
    let workspace = tempfile::tempdir().unwrap();
    let restricted = tools(workspace.path(), SandboxConfig::default());
    let mut unrestricted = ToolRegistry::new();
    unrestricted
        .register(
            TerminalTool::configured(workspace.path(), "/bin/sh", SandboxMode::Disabled).unwrap(),
        )
        .unwrap();
    let session = AgentSession::new();
    let started = call(
        &unrestricted,
        &session,
        json!({"action":"exec","cmd":"sleep 30","yield_time_ms":0}),
    )
    .await;
    for action in ["interact", "stop", "read", "release"] {
        let result = call(
            &restricted,
            &session,
            json!({"action":action,"session_id":started.output["session_id"]}),
        )
        .await;
        assert!(result.is_error);
        assert!(result.output["error"].as_str().unwrap().contains("权限"));
    }
    let list = call(&restricted, &session, json!({"action":"list"})).await;
    assert_eq!(list.output, json!({"terminals":[]}));
    let injected = call(
        &restricted,
        &session,
        json!({"action":"exec","cmd":"true","sandbox":"disabled"}),
    )
    .await;
    assert!(injected.is_error);
    let outside = call(
        &restricted,
        &session,
        json!({"action":"exec","cmd":"true","workdir":"/Users"}),
    )
    .await;
    assert!(outside.is_error);
    session.close().await.unwrap();
}

#[tokio::test]
async fn network_is_denied_by_default_and_host_can_enable_it() {
    let root = tempfile::tempdir().unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    listener.set_nonblocking(true).unwrap();
    let blocked = tools(root.path(), SandboxConfig::default());
    let session = AgentSession::new();
    let command = format!("/usr/bin/curl --silent --show-error --max-time 2 http://{address}/");
    let denied = exec(&blocked, &session, &command, false).await;
    assert_ne!(denied["exit_code"], 0, "{denied:?}");
    assert!(listener.accept().is_err(), "禁网命令不应连接宿主服务");
    let allowed = tools(
        root.path(),
        SandboxConfig {
            network: NetworkAccess::Allowed,
            ..Default::default()
        },
    );
    let listener = tokio::net::TcpListener::from_std(listener).unwrap();
    let server = async {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = [0; 2048];
        assert!(stream.read(&mut request).await.unwrap() > 0);
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
            .await
            .unwrap();
    };
    let (result, ()) = tokio::time::timeout(Duration::from_secs(10), async {
        tokio::join!(exec(&allowed, &session, &command, false), server)
    })
    .await
    .unwrap();
    assert_eq!(result["exit_code"], 0, "{result:?}");
    assert_eq!(result["output"], "ok");
    session.close().await.unwrap();
}

#[tokio::test]
async fn inherited_host_file_descriptors_cannot_bypass_the_sandbox() {
    use std::os::fd::AsRawFd;
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("work");
    std::fs::create_dir(&workspace).unwrap();
    let secret = root.path().join("secret");
    std::fs::write(&secret, "inherited-file-secret\n").unwrap();
    let file = std::fs::File::open(secret).unwrap();
    nix::fcntl::fcntl(
        &file,
        nix::fcntl::FcntlArg::F_SETFD(nix::fcntl::FdFlag::empty()),
    )
    .unwrap();
    let tools = tools(&workspace, SandboxConfig::default());
    let session = AgentSession::new();
    for tty in [false, true] {
        let command = format!(
            "IFS= read -r value <&{} && printf '%s' \"$value\"",
            file.as_raw_fd()
        );
        let result = exec(&tools, &session, &command, tty).await;
        assert_ne!(result["exit_code"], 0, "{result:?}");
        assert!(
            !result["output"]
                .as_str()
                .unwrap()
                .contains("inherited-file-secret")
        );
    }
    session.close().await.unwrap();
}

#[tokio::test]
async fn private_home_is_isolated_even_when_workspace_contains_the_host_temp_directory() {
    let workspace = sandbox_temporary_parent();
    let tools = tools(&workspace, SandboxConfig::default());
    let session = AgentSession::new();
    let first=call(&tools,&session,json!({"action":"exec","cmd":"printf command-private > \"$HOME/secret\"; printf '%s\\n' \"$HOME\"; sleep 30","yield_time_ms":100})).await;
    let first = ready(&tools, &session, first.output, |text| text.ends_with('\n')).await;
    let home = first["output"].as_str().unwrap().trim();
    assert!(Path::new(home).is_dir());
    assert!(Path::new(home).starts_with(workspace.canonicalize().unwrap()));
    assert_ne!(Some(home), std::env::var("HOME").ok().as_deref());
    let command = format!("cat '{home}/secret'");
    let denied = exec(&tools, &session, &command, false).await;
    assert_ne!(denied["exit_code"], 0);
    assert!(
        !denied["output"]
            .as_str()
            .unwrap()
            .contains("command-private")
    );
    for command in [
        "printf changed > \"$HOME/../control\"",
        "ls \"$HOME/../..\"",
        "printf changed > \"$HOME/../../launcher-0\"",
    ] {
        let denied = exec(&tools, &session, command, false).await;
        assert_ne!(denied["exit_code"], 0, "{denied:?}");
    }
    session.close().await.unwrap();
    assert!(!Path::new(home).exists());
}

#[tokio::test]
async fn inherited_environment_is_minimal_and_command_scratch_is_removed() {
    let root = tempfile::tempdir().unwrap();
    let tools = tools(root.path(), SandboxConfig::default());
    let session = AgentSession::new();
    let result=exec(&tools,&session,"printf '%s\\n%s\\n%s\\n' \"$HOME\" \"$TMPDIR\" \"${USER-unset}\"; printf ok > \"$HOME/file\"; printf ok > \"$TMPDIR/file\"",false).await;
    assert_eq!(result["exit_code"], 0, "{result:?}");
    let lines: Vec<_> = result["output"].as_str().unwrap().lines().collect();
    assert_eq!(lines.len(), 3);
    assert_ne!(Some(lines[0]), std::env::var("HOME").ok().as_deref());
    assert_eq!(lines[2], "unset");
    assert!(!Path::new(lines[0]).exists());
    #[cfg(target_os = "macos")]
    assert!(!Path::new(lines[1]).exists());
    session.close().await.unwrap();
}

#[tokio::test]
async fn sandboxed_pty_can_interact_and_processes_keep_their_original_policy() {
    let root = tempfile::tempdir().unwrap();
    let tools = tools(root.path(), SandboxConfig::default());
    let session = AgentSession::new();
    let first=call(&tools,&session,json!({"action":"exec","cmd":"stty -echo; printf ready; read value; printf '%s' \"$value\"","tty":true,"yield_time_ms":100})).await;
    let first = ready(&tools, &session, first.output, |text| text == "ready").await;
    assert_eq!(first["status"], "running");
    let last = call(
        &tools,
        &session,
        json!({"action":"interact","session_id":first["session_id"],"input":"受限交互\n"}),
    )
    .await;
    assert_eq!(last.output["output"], "受限交互");
    assert_eq!(last.output["exit_code"], 0);
    session.close().await.unwrap();
}

#[tokio::test]
async fn default_constructor_enforces_sandbox_and_quoted_paths_cannot_inject_rules() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("quote\" (allow default) \\ end");
    std::fs::create_dir(&workspace).unwrap();
    std::fs::write(root.path().join("secret"), "forbidden").unwrap();
    let mut tools = ToolRegistry::new();
    tools
        .register(TerminalTool::with_shell(&workspace, "/bin/sh").unwrap())
        .unwrap();
    let session = AgentSession::new();
    let ok = exec(&tools, &session, "printf inside > file; cat file", false).await;
    assert_eq!(ok["output"], "inside");
    let denied = exec(&tools, &session, "cat ../secret", false).await;
    assert_ne!(denied["exit_code"], 0);
    assert!(!denied["output"].as_str().unwrap().contains("forbidden"));
    session.close().await.unwrap();
}

#[test]
fn invalid_sandbox_configuration_is_rejected_instead_of_downgrading() {
    let root = tempfile::tempdir().unwrap();
    for config in [
        SandboxConfig {
            launcher: Some(root.path().join("missing")),
            ..Default::default()
        },
        SandboxConfig {
            readable_paths: vec!["relative".into()],
            ..Default::default()
        },
        SandboxConfig {
            writable_paths: vec!["/".into()],
            ..Default::default()
        },
    ] {
        assert!(
            TerminalTool::configured(root.path(), "/bin/sh", SandboxMode::Restricted(config))
                .is_err()
        );
    }
    assert!(TerminalTool::configured(root.path(), "/bin/sh", SandboxMode::Disabled).is_ok());
}

#[tokio::test]
async fn sandbox_cannot_read_host_process_environment_or_signal_host_processes() {
    let mut host = tokio::process::Command::new("/bin/sleep")
        .arg("30")
        .env("NOEMORI_SANDBOX_CANARY", "private-process-environment")
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let pid = host.id().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let tools = tools(workspace.path(), SandboxConfig::default());
    let session = AgentSession::new();
    let result = exec(&tools, &session, &format!("/bin/ps eww -p {pid}"), false).await;
    assert!(
        !result["output"]
            .as_str()
            .unwrap()
            .contains("private-process-environment"),
        "{result:?}"
    );
    let result = exec(&tools, &session, &format!("kill -TERM {pid}"), false).await;
    assert_ne!(result["exit_code"], 0, "{result:?}");
    assert!(host.try_wait().unwrap().is_none());
    host.kill().await.unwrap();
    host.wait().await.unwrap();
    session.close().await.unwrap();
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn nested_sandbox_exec_cannot_relax_inherited_restrictions() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("work");
    std::fs::create_dir(&workspace).unwrap();
    std::fs::write(root.path().join("secret"), "outside-content").unwrap();
    let tools = tools(&workspace, SandboxConfig::default());
    let session = AgentSession::new();
    let result = exec(
        &tools,
        &session,
        "/usr/bin/sandbox-exec -p '(version 1)(allow default)' /bin/cat ../secret",
        false,
    )
    .await;
    assert_ne!(result["exit_code"], 0);
    assert!(
        !result["output"]
            .as_str()
            .unwrap()
            .contains("outside-content")
    );
    session.close().await.unwrap();
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn system_developer_tools_can_resolve_runtime_configuration() {
    let workspace = tempfile::tempdir().unwrap();
    let tools = tools(workspace.path(), SandboxConfig::default());
    let session = AgentSession::new();
    for command in ["/usr/bin/git --version", "/usr/bin/clang --version"] {
        let result = exec(&tools, &session, command, false).await;
        assert_eq!(result["exit_code"], 0, "{result:?}");
        assert!(result["output"].as_str().unwrap().contains("version"));
    }
    session.close().await.unwrap();
}

#[tokio::test]
async fn visible_unix_socket_cannot_bypass_disabled_network() {
    let workspace = tempfile::tempdir().unwrap();
    let socket = workspace.path().join("host.sock");
    let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
    listener.set_nonblocking(true).unwrap();
    let tools = tools(workspace.path(), SandboxConfig::default());
    let session = AgentSession::new();
    let result=exec(&tools,&session,"/usr/bin/curl --silent --show-error --max-time 1 --unix-socket host.sock http://localhost/",false).await;
    assert_ne!(result["exit_code"], 0);
    assert!(
        listener.accept().is_err(),
        "路径可见的宿主 Unix socket 也必须被隔离"
    );
    session.close().await.unwrap();
}
