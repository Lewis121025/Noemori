use super::{call, exec, tools};
use noemori_agent::{
    AgentSession,
    tool::terminal::{SandboxConfig, SandboxEnvironment, SandboxMode, TerminalTool},
};
use serde_json::json;
use std::{collections::BTreeMap, os::unix::fs::PermissionsExt};

#[tokio::test]
async fn login_shell_semantics_are_available_in_both_pipe_and_pty() {
    let workspace = tempfile::tempdir().unwrap();
    let mut registry = noemori_agent::tool::ToolRegistry::new();
    registry
        .register(
            TerminalTool::configured(workspace.path(), "/bin/bash", SandboxMode::default())
                .unwrap(),
        )
        .unwrap();
    let session = AgentSession::new();
    for tty in [false, true] {
        for login in [false, true] {
            let result = call(&registry, &session, json!({"action":"exec", "cmd":"shopt -q login_shell; printf '%s' \"$?\"", "login":login, "tty":tty})).await;
            assert!(!result.is_error, "{result:?}");
            assert_eq!(result.output["output"], if login { "0" } else { "1" });
            let rg = call(
                &registry,
                &session,
                json!({"action":"exec", "cmd":"rg --version", "login":login, "tty":tty}),
            )
            .await;
            assert!(
                rg.output["output"]
                    .as_str()
                    .unwrap()
                    .starts_with("ripgrep 15.2.0"),
                "{rg:?}"
            );
        }
    }
    session.close().await.unwrap();
}

#[tokio::test]
async fn authorized_toolchain_paths_and_variables_work_without_opening_their_parent() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    let binaries = root.path().join("toolchain with spaces");
    let data = root.path().join("toolchain data");
    for directory in [&workspace, &binaries, &data] {
        std::fs::create_dir(directory).unwrap();
    }
    std::fs::write(data.join("version"), "custom-toolchain").unwrap();
    std::fs::write(root.path().join("private"), "outside-secret").unwrap();
    let executable = binaries.join("probe");
    std::fs::write(&executable, "#!/bin/sh\ncat \"$TOOLCHAIN_DATA/version\"\n").unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
    let config = SandboxConfig {
        readable_paths: vec![
            binaries.canonicalize().unwrap(),
            data.canonicalize().unwrap(),
        ],
        environment: SandboxEnvironment {
            executable_paths: vec![binaries.canonicalize().unwrap()],
            variables: BTreeMap::from([("TOOLCHAIN_DATA".into(), data.to_str().unwrap().into())]),
        },
        ..Default::default()
    };
    let tools = tools(&workspace, config);
    let session = AgentSession::new();
    for tty in [false, true] {
        let result = exec(&tools, &session, "probe", tty).await;
        assert_eq!(result["exit_code"], 0, "{result:?}");
        assert_eq!(result["output"], "custom-toolchain");
        let denied = exec(&tools, &session, "cat ../private", tty).await;
        assert_ne!(denied["exit_code"], 0);
        assert!(
            !denied["output"]
                .as_str()
                .unwrap()
                .contains("outside-secret")
        );
    }
    session.close().await.unwrap();
}

#[test]
fn invalid_environment_cannot_silently_expand_permissions_or_replace_runtime_boundaries() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    let outside = root.path().join("outside");
    std::fs::create_dir(&workspace).unwrap();
    std::fs::create_dir(&outside).unwrap();
    let bad = [
        SandboxEnvironment {
            executable_paths: vec![outside],
            ..Default::default()
        },
        SandboxEnvironment {
            executable_paths: vec!["relative".into()],
            ..Default::default()
        },
        SandboxEnvironment {
            variables: BTreeMap::from([("HOME".into(), root.path().to_str().unwrap().into())]),
            ..Default::default()
        },
        SandboxEnvironment {
            variables: BTreeMap::from([("INVALID=KEY".into(), "value".into())]),
            ..Default::default()
        },
        SandboxEnvironment {
            variables: BTreeMap::from([("NAME".into(), "value\0".into())]),
            ..Default::default()
        },
    ];
    for environment in bad {
        let result = TerminalTool::configured(
            &workspace,
            "/bin/sh",
            SandboxMode::Restricted(SandboxConfig {
                environment,
                ..Default::default()
            }),
        );
        assert!(result.is_err(), "无效环境必须在启动任何命令前被拒绝");
    }
}

#[tokio::test]
async fn different_host_environment_cannot_reuse_or_read_an_existing_process() {
    let workspace = tempfile::tempdir().unwrap();
    let configuration = |value: &str| SandboxConfig {
        environment: SandboxEnvironment {
            variables: BTreeMap::from([("TOOLCHAIN_PROFILE".into(), value.into())]),
            ..Default::default()
        },
        ..Default::default()
    };
    let first = tools(workspace.path(), configuration("first"));
    let other = tools(workspace.path(), configuration("other"));
    let session = AgentSession::new();
    let started = call(
        &first,
        &session,
        json!({"action":"exec", "cmd":"printf first; sleep 30", "yield_time_ms":100}),
    )
    .await;
    for action in ["interact", "read", "stop", "release"] {
        let denied = call(
            &other,
            &session,
            json!({"action":action, "session_id":started.output["session_id"]}),
        )
        .await;
        assert!(denied.is_error, "{denied:?}");
        assert!(denied.output["error"].as_str().unwrap().contains("权限"));
    }
    assert_eq!(
        call(&other, &session, json!({"action":"list"}))
            .await
            .output,
        json!({"terminals":[]})
    );
    session.close().await.unwrap();
}

#[tokio::test]
async fn explicitly_authorized_rust_toolchain_builds_and_tests_offline_inside_sandbox() {
    let sysroot = std::process::Command::new("rustc")
        .args(["--print", "sysroot"])
        .output()
        .unwrap();
    assert!(sysroot.status.success());
    let sysroot = std::path::PathBuf::from(String::from_utf8(sysroot.stdout).unwrap().trim())
        .canonicalize()
        .unwrap();
    let workspace = tempfile::tempdir().unwrap();
    std::fs::write(workspace.path().join("Cargo.toml"), "[package]\nname = \"sandbox-probe\"\nversion = \"0.1.0\"\nedition = \"2024\"\n[workspace]\n[lib]\npath = \"lib.rs\"\n").unwrap();
    std::fs::write(
        workspace.path().join("lib.rs"),
        "#[test] fn sandbox_can_compile_and_execute() { assert_eq!(2 + 2, 4); }\n",
    )
    .unwrap();
    let tools = tools(
        workspace.path(),
        SandboxConfig {
            readable_paths: vec![sysroot.clone()],
            environment: SandboxEnvironment {
                executable_paths: vec![sysroot.join("bin")],
                ..Default::default()
            },
            ..Default::default()
        },
    );
    let session = AgentSession::new();
    let result = exec(
        &tools,
        &session,
        "cargo test --offline --color never --quiet",
        false,
    )
    .await;
    assert_eq!(result["exit_code"], 0, "{result:?}");
    assert!(
        result["output"].as_str().unwrap().contains("1 passed"),
        "{result:?}"
    );
    session.close().await.unwrap();
}
