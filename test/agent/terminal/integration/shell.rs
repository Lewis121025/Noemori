use super::{call, context, output};
use base64::{Engine, engine::general_purpose::STANDARD};
use noemori_agent::{
    AgentSession, CancellationToken, Error, ExecutionContext,
    tool::{
        ToolRegistry,
        terminal::{SandboxConfig, SandboxMode, TerminalShellOptions, TerminalTool},
    },
};
use serde_json::json;
use std::{path::Path, time::Duration};

fn registry(tool: TerminalTool) -> ToolRegistry {
    let mut tools = ToolRegistry::new();
    tools.register(tool).unwrap();
    tools
}

fn profile(home: &Path, shell: &str, value: &str) {
    let filename = if shell.ends_with("zsh") {
        ".zshrc"
    } else {
        ".bash_profile"
    };
    std::fs::write(home.join(filename), format!(
        "printf 'startup banner\\n'\nprintf 'startup diagnostic\\n' >&2\nexport PROFILE_TOKEN='{value}'\nPROFILE_LOCAL='local state'\nreadonly PROFILE_CONST='constant'\nPROFILE_ARRAY=('first value' '中文')\nexport PROFILE_ORIGIN=\"$HOME\"\nfixture_helper() {{ printf '%s|%s|%s|%s|%s' \"$PROFILE_TOKEN\" \"$PROFILE_LOCAL\" \"$PROFILE_CONST\" \"${{PROFILE_ARRAY[*]}}\" \"$1\"; }}\nalias fixture_alias='fixture_helper'\nPATH=\"$HOME/bin:$PATH\"; export PATH\n"
    )).unwrap();
}

fn restricted(workspace: &Path, shell: &str, homes: Vec<std::path::PathBuf>) -> TerminalTool {
    TerminalTool::configured(
        workspace,
        shell,
        SandboxMode::Restricted(SandboxConfig {
            readable_paths: homes,
            ..Default::default()
        }),
    )
    .unwrap()
}

#[tokio::test]
async fn host_can_disable_login_before_command_dispatch_and_choose_the_default_mode() {
    let workspace = tempfile::tempdir().unwrap();
    let base =
        TerminalTool::configured(workspace.path(), "/bin/bash", SandboxMode::default()).unwrap();
    assert!(
        base.clone()
            .with_shell_options(TerminalShellOptions {
                allow_login: false,
                default_login: true
            })
            .is_err()
    );
    let denied = registry(
        base.clone()
            .with_shell_options(TerminalShellOptions {
                allow_login: false,
                default_login: false,
            })
            .unwrap(),
    );
    let session = AgentSession::new();
    let result = call(
        &denied,
        &session,
        json!({"action":"exec", "cmd":"touch forbidden", "login":true}),
    )
    .await;
    assert!(result.is_error);
    assert!(
        result.output["error"]
            .as_str()
            .unwrap()
            .contains("禁止登录")
    );
    assert!(!workspace.path().join("forbidden").exists());
    let plain = output(
        &denied,
        &session,
        json!({"action":"exec", "cmd":"shopt -q login_shell; printf '%s' \"$?\""}),
    )
    .await;
    assert_eq!(plain["output"], "1");
    let defaults = registry(
        base.with_shell_options(TerminalShellOptions {
            allow_login: true,
            default_login: true,
        })
        .unwrap(),
    );
    let login = output(
        &defaults,
        &session,
        json!({"action":"exec", "cmd":"shopt -q login_shell; printf '%s' \"$?\""}),
    )
    .await;
    assert_eq!(login["output"], "0");
    session.close().await.unwrap();
}

#[tokio::test]
async fn snapshots_keep_variables_functions_aliases_and_do_not_rerun_changed_profiles() {
    use std::os::unix::fs::PermissionsExt;
    for shell in ["/bin/bash", "/bin/zsh"] {
        assert!(Path::new(shell).is_file(), "验收环境需安装 {shell}");
        let workspace = tempfile::tempdir().unwrap();
        let home = tempfile::Builder::new()
            .prefix("noemori-profile 'quoted' ")
            .tempdir()
            .unwrap();
        std::fs::create_dir(home.path().join("bin")).unwrap();
        let fake_rg = home.path().join("bin/rg");
        std::fs::write(&fake_rg, "#!/bin/sh\nprintf shadowed").unwrap();
        std::fs::set_permissions(&fake_rg, std::fs::Permissions::from_mode(0o755)).unwrap();
        profile(home.path(), shell, "第一行\n第二行");
        let captured = restricted(workspace.path(), shell, vec![home.path().to_owned()])
            .capture_shell_snapshot(home.path(), context())
            .await
            .unwrap();
        profile(home.path(), shell, "changed after capture");
        let tools = registry(captured);
        let session = AgentSession::new();
        for tty in [false, true] {
            let result = output(
                &tools,
                &session,
                json!({"action":"exec", "cmd":"fixture_alias 'arg with spaces'", "tty":tty}),
            )
            .await;
            assert_eq!(result["exit_code"], 0, "{shell}: {result:?}");
            assert_eq!(
                result["output"].as_str().unwrap().replace("\r\n", "\n"),
                "第一行\n第二行|local state|constant|first value 中文|arg with spaces"
            );
            let rg = output(
                &tools,
                &session,
                json!({"action":"exec", "cmd":"rg --version", "tty":tty}),
            )
            .await;
            assert!(rg["output"].as_str().unwrap().starts_with("ripgrep 15.2.0"));
        }
        let directories = output(
            &tools,
            &session,
            json!({"action":"exec", "cmd":"printf '%s\\n%s' \"$PROFILE_ORIGIN\" \"$HOME\""}),
        )
        .await;
        let text = directories["output"].as_str().unwrap();
        assert!(
            text.starts_with(&format!(
                "{}\n",
                home.path().canonicalize().unwrap().display()
            )),
            "{shell}: {text}"
        );
        assert!(text.lines().nth(1).unwrap().contains("noemori-sandbox-"));
        assert!(
            !text
                .lines()
                .nth(1)
                .unwrap()
                .starts_with(home.path().to_str().unwrap())
        );
        let plain = output(
            &tools,
            &session,
            json!({"action":"exec", "cmd":"printf '%s' \"${PROFILE_TOKEN-unset}\"", "login":false}),
        )
        .await;
        assert_eq!(plain["output"], "unset");
        let positions = output(&tools, &session, json!({"action":"exec", "cmd":"printf '%s|%s' \"$#\" '${not expanded}'; printf '%s' '$(touch unexpected)'"})).await;
        assert_eq!(positions["output"], "0|${not expanded}$(touch unexpected)");
        assert!(!workspace.path().join("unexpected").exists());
        session.close().await.unwrap();
    }
}

#[tokio::test]
async fn unauthorized_startup_files_are_rejected_and_supported_capture_failures_are_explicit() {
    let workspace = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    profile(home.path(), "/bin/bash", "private");
    let denied = restricted(workspace.path(), "/bin/bash", vec![])
        .capture_shell_snapshot(home.path(), context())
        .await;
    assert!(matches!(denied, Err(Error::Config(reason)) if reason.contains("读取授权")));
    let unsupported = TerminalTool::configured(workspace.path(), "/bin/sh", SandboxMode::Disabled)
        .unwrap()
        .capture_shell_snapshot(home.path(), context())
        .await;
    assert!(matches!(unsupported, Err(Error::Unsupported(_))));
    std::fs::write(home.path().join(".bash_profile"), "exit 17").unwrap();
    let failed = restricted(workspace.path(), "/bin/bash", vec![home.path().to_owned()])
        .capture_shell_snapshot(home.path(), context())
        .await;
    assert!(matches!(failed, Err(Error::Config(reason)) if reason.contains("采集未成功")));
}

#[tokio::test]
async fn snapshot_identity_is_part_of_process_ownership_even_with_equal_file_permissions() {
    let workspace = tempfile::tempdir().unwrap();
    let home_a = tempfile::tempdir().unwrap();
    let home_b = tempfile::tempdir().unwrap();
    profile(home_a.path(), "/bin/bash", "A");
    profile(home_b.path(), "/bin/bash", "B");
    for sandbox in [false, true] {
        let base = if sandbox {
            restricted(
                workspace.path(),
                "/bin/bash",
                vec![home_a.path().to_owned(), home_b.path().to_owned()],
            )
        } else {
            TerminalTool::configured(workspace.path(), "/bin/bash", SandboxMode::Disabled).unwrap()
        };
        let first = registry(
            base.clone()
                .capture_shell_snapshot(home_a.path(), context())
                .await
                .unwrap(),
        );
        let other = registry(
            base.capture_shell_snapshot(home_b.path(), context())
                .await
                .unwrap(),
        );
        let session = AgentSession::new();
        let started = output(&first, &session, json!({"action":"exec", "cmd":"printf '%s' \"$PROFILE_TOKEN\"; sleep 30", "yield_time_ms":100})).await;
        assert_eq!(started["output"], "A");
        for action in ["read", "read_bytes", "interact", "stop", "release"] {
            assert!(
                call(
                    &other,
                    &session,
                    json!({"action":action, "session_id":started["session_id"]})
                )
                .await
                .is_error
            );
        }
        assert_eq!(
            output(&other, &session, json!({"action":"list"})).await,
            json!({"terminals":[]})
        );
        session.close().await.unwrap();
    }
}

#[tokio::test]
async fn cancelling_snapshot_capture_stops_the_initializer_and_cleans_its_process() {
    use nix::{sys::stat::Mode, unistd::mkfifo};
    use tokio::io::AsyncReadExt;
    let workspace = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let alive = workspace.path().join("alive");
    mkfifo(&alive, Mode::S_IRUSR | Mode::S_IWUSR).unwrap();
    std::fs::write(
        home.path().join(".bash_profile"),
        "exec 9> alive; printf s >&9; sleep 30; touch should-not-exist",
    )
    .unwrap();
    let cancellation = CancellationToken::new();
    let context = ExecutionContext::new(cancellation.clone(), Duration::from_secs(5)).unwrap();
    let tool = restricted(workspace.path(), "/bin/bash", vec![home.path().to_owned()]);
    let capturing = tool.capture_shell_snapshot(home.path(), context);
    let cancel = async {
        tokio::time::timeout(Duration::from_secs(5), async {
            // 管道 EOF 验证初始化器及继承描述符的子进程已退出，不混用沙箱和宿主 PID。
            let mut pipe = tokio::fs::File::open(&alive).await.unwrap();
            let mut ready = [0];
            pipe.read_exact(&mut ready).await.unwrap();
            assert_eq!(ready, *b"s");
            cancellation.cancel();
            let mut remaining = Vec::new();
            pipe.read_to_end(&mut remaining).await.unwrap();
            assert!(remaining.is_empty());
        })
        .await
        .expect("取消必须回收初始化器及其子进程持有的管道");
    };
    let (result, ()) = tokio::join!(capturing, cancel);
    assert!(matches!(result, Err(Error::Cancelled)));
    assert!(!workspace.path().join("should-not-exist").exists());
}

#[tokio::test]
async fn snapshots_restore_parser_and_expansion_options_before_restoring_functions() {
    for (shell, configuration, command, expected) in [
        (
            "/bin/bash",
            "shopt -s extglob nullglob\nset -o pipefail\nfixture_pattern() {\ncase \"$1\" in @(alpha|beta)) printf match;; *) printf miss;; esac\n}\n",
            "fixture_pattern beta; shopt -q extglob; printf ':%s' \"$?\"; shopt -q nullglob; printf ':%s' \"$?\"; false | true; printf ':%s' \"$?\"",
            "match:0:0:1",
        ),
        (
            "/bin/zsh",
            "setopt extendedglob shwordsplit\nfixture_pattern() {\n[[ $1 = (#i)alpha ]] && printf match\nlocal parts='one two'; printf ':%s' ${#${=parts}}\n}\n",
            "fixture_pattern ALPHA; printf ':%s:%s' $options[extendedglob] $options[shwordsplit]",
            "match:2:on:on",
        ),
    ] {
        let workspace = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let filename = if shell.ends_with("zsh") {
            ".zshrc"
        } else {
            ".bash_profile"
        };
        std::fs::write(home.path().join(filename), configuration).unwrap();
        let captured = restricted(workspace.path(), shell, vec![home.path().to_owned()])
            .capture_shell_snapshot(home.path(), context())
            .await
            .unwrap();
        std::fs::write(home.path().join(filename), "").unwrap();
        let tools = registry(captured);
        let session = AgentSession::new();
        for tty in [false, true] {
            let result = output(
                &tools,
                &session,
                json!({"action":"exec", "cmd":command, "tty":tty}),
            )
            .await;
            assert_eq!(result["exit_code"], 0, "{shell}: {result:?}");
            assert_eq!(result["output"], expected, "{shell}: {result:?}");
        }
        session.close().await.unwrap();
    }
}

#[tokio::test]
async fn snapshots_restore_functions_and_aliases_that_share_a_name_without_rewriting_the_function()
{
    for shell in ["/bin/bash", "/bin/zsh"] {
        let workspace = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let filename = if shell.ends_with("zsh") {
            ".zshrc"
        } else {
            ".bash_profile"
        };
        std::fs::write(home.path().join(filename), "fixture_shared() { printf function; }\nfixture_target() { printf alias; }\nalias fixture_shared=fixture_target\n").unwrap();
        let captured = restricted(workspace.path(), shell, vec![home.path().to_owned()])
            .capture_shell_snapshot(home.path(), context())
            .await
            .unwrap();
        let tools = registry(captured);
        let session = AgentSession::new();
        let result = output(&tools, &session, json!({"action":"exec", "cmd":"fixture_shared; builtin unalias fixture_shared; eval fixture_shared"})).await;
        assert_eq!(result["exit_code"], 0, "{shell}: {result:?}");
        assert_eq!(result["output"], "aliasfunction", "{shell}: {result:?}");
        session.close().await.unwrap();
    }
}

#[tokio::test]
async fn background_commands_keep_their_snapshot_after_the_last_tool_is_dropped() {
    use noemori_agent::tool::terminal::TerminalEvent;
    let workspace = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    std::fs::write(
        home.path().join(".bash_profile"),
        "fixture_source() { printf '%s' \"${BASH_SOURCE[0]}\"; }\n",
    )
    .unwrap();
    let captured = restricted(workspace.path(), "/bin/bash", vec![home.path().to_owned()])
        .capture_shell_snapshot(home.path(), context())
        .await
        .unwrap();
    let tools = registry(captured.clone());
    let session = AgentSession::new();
    let first = output(&tools, &session, json!({"action":"exec", "cmd":"snapshot_file=$(fixture_source); printf '%s\\n' \"$snapshot_file\"; while ! test -f continue; do sleep 0.01; done; if test -r \"$snapshot_file\"; then printf retained; else printf missing; fi", "yield_time_ms":1000})).await;
    assert_eq!(first["status"], "running");
    let cache = std::path::PathBuf::from(first["output"].as_str().unwrap().trim());
    assert!(cache.is_file());
    let mut subscription = captured
        .subscribe(
            &session,
            first["session_id"].as_str().unwrap(),
            first["output"].as_str().unwrap().len() as u64,
        )
        .unwrap();
    drop(tools);
    drop(captured);
    assert!(
        cache.is_file(),
        "进程仍使用初始化文件时，工具释放不能提前删掉快照"
    );
    std::fs::write(workspace.path().join("continue"), "ready").unwrap();
    let mut bytes = Vec::new();
    while let Some(event) = subscription.recv().await.unwrap() {
        if let TerminalEvent::Output { chunk, .. } = event {
            bytes.extend(STANDARD.decode(chunk.data_base64).unwrap());
        }
    }
    assert_eq!(bytes, b"retained");
    assert!(!cache.exists(), "进程退出后应释放最后一个快照依赖");
    session.close().await.unwrap();
}

#[tokio::test]
async fn only_the_selected_snapshot_is_mounted_into_each_sandbox() {
    let workspace = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    std::fs::write(
        home.path().join(".bash_profile"),
        "export PROFILE_TOKEN=first\nfixture_source() { printf '%s' \"${BASH_SOURCE[0]}\"; }\n",
    )
    .unwrap();
    let base = restricted(workspace.path(), "/bin/bash", vec![home.path().to_owned()]);
    let first = registry(
        base.clone()
            .capture_shell_snapshot(home.path(), context())
            .await
            .unwrap(),
    );
    std::fs::write(
        home.path().join(".bash_profile"),
        "export PROFILE_TOKEN=second\n",
    )
    .unwrap();
    let other = registry(
        base.capture_shell_snapshot(home.path(), context())
            .await
            .unwrap(),
    );
    let session = AgentSession::new();
    let cache = output(
        &first,
        &session,
        json!({"action":"exec", "cmd":"fixture_source"}),
    )
    .await;
    let started = output(&other, &session, json!({"action":"exec", "cmd":"IFS= read -r target; cat -- \"$target\"", "stdin":true, "yield_time_ms":0})).await;
    let denied = output(&other, &session, json!({"action":"interact", "session_id":started["session_id"], "input":format!("{}\n", cache["output"].as_str().unwrap()), "close_stdin":true})).await;
    assert_ne!(
        denied["exit_code"], 0,
        "其他快照不能从共享运行目录中被读到：{denied:?}"
    );
    assert!(
        !denied["output"]
            .as_str()
            .unwrap()
            .contains("PROFILE_TOKEN=")
    );
    session.close().await.unwrap();
}

#[tokio::test]
async fn oversized_snapshots_fail_explicitly_and_an_empty_profile_still_produces_a_valid_snapshot()
{
    let workspace = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    std::fs::write(
        home.path().join(".bash_profile"),
        "PROFILE_LARGE=$(printf '%1200000s' x)\n",
    )
    .unwrap();
    let base = restricted(workspace.path(), "/bin/bash", vec![home.path().to_owned()]);
    let failed = base
        .clone()
        .capture_shell_snapshot(home.path(), context())
        .await;
    let failure = failed.err().expect("超预算快照不能安装成功");
    assert!(
        matches!(&failure, Error::Config(reason) if reason.contains("预算")),
        "{failure:?}"
    );
    std::fs::write(home.path().join(".bash_profile"), "").unwrap();
    let tools = registry(
        base.capture_shell_snapshot(home.path(), context())
            .await
            .unwrap(),
    );
    let session = AgentSession::new();
    let result = output(
        &tools,
        &session,
        json!({"action":"exec", "cmd":"printf valid"}),
    )
    .await;
    assert_eq!(result["output"], "valid");
    session.close().await.unwrap();
}

#[tokio::test]
async fn zsh_uses_the_host_startup_directory_once_and_restores_its_function_state() {
    use noemori_agent::tool::terminal::SandboxEnvironment;
    let workspace = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    let configuration = tempfile::tempdir().unwrap();
    std::fs::write(
        configuration.path().join(".zshenv"),
        "printf initializer\nexport DOT_TOKEN=original\n",
    )
    .unwrap();
    std::fs::write(
        configuration.path().join(".zshrc"),
        "dot_helper() { printf '%s:%s' \"$DOT_TOKEN\" \"$ZDOTDIR\"; }\n",
    )
    .unwrap();
    let base = TerminalTool::configured(
        workspace.path(),
        "/bin/zsh",
        SandboxMode::Restricted(SandboxConfig {
            readable_paths: vec![configuration.path().to_owned()],
            environment: SandboxEnvironment {
                variables: std::collections::BTreeMap::from([(
                    "ZDOTDIR".into(),
                    configuration
                        .path()
                        .canonicalize()
                        .unwrap()
                        .to_str()
                        .unwrap()
                        .into(),
                )]),
                ..Default::default()
            },
            ..Default::default()
        }),
    )
    .unwrap();
    let captured = base
        .capture_shell_snapshot(home.path(), context())
        .await
        .unwrap();
    std::fs::write(
        configuration.path().join(".zshenv"),
        "printf must-not-run\nexport DOT_TOKEN=changed\n",
    )
    .unwrap();
    let tools = registry(captured);
    let session = AgentSession::new();
    let result = output(
        &tools,
        &session,
        json!({"action":"exec", "cmd":"dot_helper"}),
    )
    .await;
    assert_eq!(
        result["output"],
        format!(
            "original:{}",
            configuration.path().canonicalize().unwrap().display()
        )
    );
    session.close().await.unwrap();
}

#[tokio::test]
async fn bash_env_is_restored_for_explicit_children_without_rerunning_it_before_the_snapshot() {
    use noemori_agent::tool::terminal::SandboxEnvironment;
    let workspace = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    std::fs::write(home.path().join(".bash_profile"), "").unwrap();
    let initializer = home.path().join("nonlogin");
    std::fs::write(
        &initializer,
        "printf child-initializer:\nexport BASH_ENV_LOADED=yes\n",
    )
    .unwrap();
    let captured = TerminalTool::configured(
        workspace.path(),
        "/bin/bash",
        SandboxMode::Restricted(SandboxConfig {
            readable_paths: vec![home.path().to_owned()],
            environment: SandboxEnvironment {
                variables: std::collections::BTreeMap::from([(
                    "BASH_ENV".into(),
                    initializer.canonicalize().unwrap().to_str().unwrap().into(),
                )]),
                ..Default::default()
            },
            ..Default::default()
        }),
    )
    .unwrap()
    .capture_shell_snapshot(home.path(), context())
    .await
    .unwrap();
    let tools = registry(captured);
    let session = AgentSession::new();
    let parent = output(
        &tools,
        &session,
        json!({"action":"exec", "cmd":"printf 'parent:%s' \"${BASH_ENV_LOADED-unset}\""}),
    )
    .await;
    assert_eq!(parent["output"], "parent:unset");
    let child = output(
        &tools,
        &session,
        json!({"action":"exec", "cmd":"bash -c 'printf \"%s\" \"${BASH_ENV_LOADED-unset}\"'"}),
    )
    .await;
    assert_eq!(child["output"], "child-initializer:yes");
    session.close().await.unwrap();
}

#[tokio::test]
async fn shell_initialization_cannot_override_the_explicit_command_working_directory() {
    use noemori_agent::tool::terminal::SandboxEnvironment;
    let workspace = tempfile::tempdir().unwrap();
    let configuration = tempfile::tempdir().unwrap();
    let shifted = tempfile::tempdir().unwrap();
    let requested = workspace.path().join("requested");
    std::fs::create_dir(&requested).unwrap();
    let initializer = configuration.path().join("startup");
    std::fs::write(&initializer, "cd \"$SHIFTED_DIR\"\n").unwrap();
    let tools = registry(
        TerminalTool::configured(
            workspace.path(),
            "/bin/bash",
            SandboxMode::Restricted(SandboxConfig {
                readable_paths: vec![configuration.path().to_owned(), shifted.path().to_owned()],
                environment: SandboxEnvironment {
                    variables: std::collections::BTreeMap::from([
                        (
                            "BASH_ENV".into(),
                            initializer.canonicalize().unwrap().to_str().unwrap().into(),
                        ),
                        (
                            "SHIFTED_DIR".into(),
                            shifted
                                .path()
                                .canonicalize()
                                .unwrap()
                                .to_str()
                                .unwrap()
                                .into(),
                        ),
                    ]),
                    ..Default::default()
                },
                ..Default::default()
            }),
        )
        .unwrap(),
    );
    let session = AgentSession::new();
    for login in [false, true] {
        let result = output(&tools, &session, json!({"action":"exec", "cmd":"printf '%s' \"$PWD\"", "workdir":requested, "login":login})).await;
        assert_eq!(
            result["output"],
            requested.canonicalize().unwrap().to_str().unwrap(),
            "初始化不能改变已选择的工作目录"
        );
    }
    session.close().await.unwrap();
}
