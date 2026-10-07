use super::*;

#[test]
fn prefix_matching_preserves_literal_words_and_never_evaluates_shell_syntax() {
    for (command, words) in [
        ("git status --short", vec!["git", "status", "--short"]),
        (
            "g'it' status -- 'a file'",
            vec!["git", "status", "--", "a file"],
        ),
        (
            "git status -- '$(touch unexpected)'",
            vec!["git", "status", "--", "$(touch unexpected)"],
        ),
        (
            r#"git status -- "a file" a\;b"#,
            vec!["git", "status", "--", "a file", "a;b"],
        ),
    ] {
        assert_eq!(
            literal_command(command),
            Some(words.into_iter().map(str::to_owned).collect())
        );
    }
    for command in [
        "git status; touch unexpected",
        "git status && touch unexpected",
        "git status | cat",
        "git status > result",
        "git status < input",
        "git status $(touch unexpected)",
        "git status \"$(touch unexpected)\"",
        "git status `touch unexpected`",
        "git status $ARG",
        "git status *.rs",
        "git status ~/secret",
        "git status\ntouch unexpected",
        "git status # comment",
        "ARG=x git status",
        "git status 'unterminated",
        "git status \\",
        "(git status)",
        "{ git status; }",
    ] {
        assert!(
            literal_command(command).is_none(),
            "不能自动批准复杂或不完整的命令：{command}"
        );
    }
}

#[test]
fn resource_reuse_does_not_upgrade_reading_files_or_widen_directory_and_network_permissions() {
    let permissions = TerminalPermissionGrant {
        readable: vec![TerminalReadGrant {
            path: "/read-only/file".into(),
            recursive: false,
        }],
        writable: vec!["/write-directory".into()],
        network: false,
    };
    assert!(permissions.contains(&TerminalPermissionGrant {
        readable: vec![TerminalReadGrant {
            path: "/read-only/file".into(),
            recursive: false
        }],
        writable: vec![],
        network: false
    }));
    assert!(permissions.contains(&TerminalPermissionGrant {
        readable: vec![TerminalReadGrant {
            path: "/write-directory/child".into(),
            recursive: false
        }],
        writable: vec!["/write-directory/child".into()],
        network: false
    }));
    for requested in [
        TerminalPermissionGrant {
            readable: vec![TerminalReadGrant {
                path: "/read-only/file".into(),
                recursive: true,
            }],
            writable: vec![],
            network: false,
        },
        TerminalPermissionGrant {
            readable: vec![],
            writable: vec!["/read-only".into()],
            network: false,
        },
        TerminalPermissionGrant {
            readable: vec![],
            writable: vec!["/write-directory-sibling".into()],
            network: false,
        },
        TerminalPermissionGrant {
            readable: vec![],
            writable: vec![],
            network: true,
        },
    ] {
        assert!(!permissions.contains(&requested));
    }
}

#[test]
fn persistent_rule_loader_rejects_invalid_versions_symlinks_duplicates_and_unbounded_files() {
    let directory = tempfile::tempdir().unwrap();
    let file = directory.path().join("rules.json");
    assert!(
        TerminalApprovalStore::open(&file)
            .unwrap()
            .rules()
            .is_empty()
    );
    for content in [
        "",
        "{}",
        r#"{"version":2,"rules":[]}"#,
        r#"{"version":1,"rules":[],"approved":true}"#,
    ] {
        std::fs::write(&file, content).unwrap();
        assert!(TerminalApprovalStore::open(&file).is_err());
    }
    std::fs::write(&file, vec![b' '; MAX_STORE_BYTES + 1]).unwrap();
    assert!(TerminalApprovalStore::open(&file).is_err());
    std::fs::write(&file, r#"{"version":1,"rules":[]}"#).unwrap();
    let link = directory.path().join("link.json");
    std::os::unix::fs::symlink(&file, &link).unwrap();
    assert!(TerminalApprovalStore::open(&link).is_err());
}

#[test]
fn rule_store_is_exclusive_and_reopening_after_drop_releases_the_real_file_lock() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("rules.json");
    let store = TerminalApprovalStore::open(&path).unwrap();
    assert!(TerminalApprovalStore::open(&path).is_err());
    drop(store);
    assert!(TerminalApprovalStore::open(&path).is_ok());
}
