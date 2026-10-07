use super::*;

fn rule(prefix: &[&str], decision: TerminalCommandDecision) -> TerminalCommandRule {
    TerminalCommandRule {
        pattern: prefix
            .iter()
            .map(|word| TerminalCommandPattern::Word((*word).into()))
            .collect(),
        decision,
        justification: Some("test policy".into()),
        matches: vec![],
        not_matches: vec![],
    }
}

#[test]
fn every_command_is_evaluated_and_the_strictest_rule_wins_independently_of_order() {
    for rules in [
        vec![
            rule(&["git"], TerminalCommandDecision::Allow),
            rule(&["git", "status"], TerminalCommandDecision::Prompt),
            rule(&["touch"], TerminalCommandDecision::Forbidden),
        ],
        vec![
            rule(&["touch"], TerminalCommandDecision::Forbidden),
            rule(&["git", "status"], TerminalCommandDecision::Prompt),
            rule(&["git"], TerminalCommandDecision::Allow),
        ],
    ] {
        let policy = TerminalCommandPolicy::new(rules).unwrap();
        let checked = policy
            .evaluate(
                Path::new("/bin/bash"),
                false,
                "git status&&touch target|cat;git diff",
            )
            .unwrap();
        assert_eq!(checked.decision, Some(TerminalCommandDecision::Forbidden));
        assert_eq!(
            checked.commands,
            vec![
                vec!["git", "status"],
                vec!["touch", "target"],
                vec!["cat"],
                vec!["git", "diff"]
            ]
        );
        assert!(!checked.all_commands_allowed);
        assert!(checked.fully_parsed);
        assert_eq!(checked.matches.len(), 3);
    }
}

#[test]
fn allowed_prefix_cannot_cover_an_unmatched_neighbour_and_unions_match_exact_argument_positions() {
    let mut allowed = rule(&["git"], TerminalCommandDecision::Allow);
    allowed.pattern.push(TerminalCommandPattern::AnyOf(vec![
        "status".into(),
        "diff".into(),
    ]));
    allowed
        .matches
        .push(vec!["git".into(), "diff".into(), "--stat".into()]);
    allowed
        .not_matches
        .push(vec!["git".into(), "commit".into()]);
    let policy = TerminalCommandPolicy::new(vec![allowed]).unwrap();
    assert!(
        policy
            .evaluate(Path::new("/bin/sh"), false, "git status; git diff")
            .unwrap()
            .all_commands_allowed
    );
    assert!(
        !policy
            .evaluate(Path::new("/bin/sh"), false, "git status; touch target")
            .unwrap()
            .all_commands_allowed
    );
    assert_eq!(
        policy
            .evaluate(Path::new("/bin/sh"), false, "git commit")
            .unwrap()
            .decision,
        None
    );
}

#[test]
fn nested_shell_wrappers_are_split_and_quoted_operators_remain_literal_arguments() {
    let policy =
        TerminalCommandPolicy::new(vec![rule(&["touch"], TerminalCommandDecision::Forbidden)])
            .unwrap();
    for command in [
        "bash -lc 'git status && touch target'",
        "zsh --login -c 'git status || touch target'",
        "sh -c \"bash -c 'touch target'\"",
    ] {
        let checked = policy
            .evaluate(Path::new("/bin/bash"), false, command)
            .unwrap();
        assert_eq!(
            checked.decision,
            Some(TerminalCommandDecision::Forbidden),
            "{command}: {checked:?}"
        );
        assert!(checked.fully_parsed);
    }
    let checked = policy
        .evaluate(
            Path::new("/bin/sh"),
            false,
            "printf '%s' '&& touch target' a\\;b",
        )
        .unwrap();
    assert_eq!(
        checked.commands,
        vec![vec!["printf", "%s", "&& touch target", "a;b"]]
    );
    assert_eq!(checked.decision, None);
}

#[test]
fn builtin_dispatch_cannot_hide_a_forbidden_executable_and_unknown_shell_modes_require_approval() {
    let policy =
        TerminalCommandPolicy::new(vec![rule(&["touch"], TerminalCommandDecision::Forbidden)])
            .unwrap();
    for command in [
        "exec touch target",
        "exec -- touch target",
        "command touch target",
        "command -p touch target",
        "sh -c 'exec touch target'",
    ] {
        let checked = policy
            .evaluate(Path::new("/bin/sh"), false, command)
            .unwrap();
        assert_eq!(
            checked.decision,
            Some(TerminalCommandDecision::Forbidden),
            "{command}: {checked:?}"
        );
    }
    for command in [
        "bash -ic 'touch target'",
        "eval 'touch target'",
        "source startup",
    ] {
        let checked = policy
            .evaluate(Path::new("/bin/sh"), false, command)
            .unwrap();
        assert!(!checked.fully_parsed, "{command}: {checked:?}");
        assert_eq!(checked.decision, Some(TerminalCommandDecision::Prompt));
    }
    let query = policy
        .evaluate(Path::new("/bin/sh"), false, "command -v touch")
        .unwrap();
    assert_eq!(query.decision, None);
    assert!(query.fully_parsed);
}

#[test]
fn rules_for_explicit_wrappers_are_not_discarded_when_their_inner_command_is_allowed() {
    let policy = TerminalCommandPolicy::new(vec![
        rule(&["bash"], TerminalCommandDecision::Forbidden),
        rule(&["exec"], TerminalCommandDecision::Forbidden),
        rule(&["printf"], TerminalCommandDecision::Allow),
    ])
    .unwrap();
    for command in ["bash -c 'printf allowed'", "exec printf allowed"] {
        let checked = policy
            .evaluate(Path::new("/bin/sh"), false, command)
            .unwrap();
        assert_eq!(
            checked.decision,
            Some(TerminalCommandDecision::Forbidden),
            "{command}: {checked:?}"
        );
    }
}

#[test]
fn advanced_or_malformed_scripts_keep_the_complete_invocation_and_require_full_approval() {
    let policy =
        TerminalCommandPolicy::new(vec![rule(&["git"], TerminalCommandDecision::Allow)]).unwrap();
    for command in [
        "git status > result",
        "git status $(touch target)",
        "VALUE=x git status",
        "git status *.rs",
        "if true; then git status; fi",
        "git status &",
        "git status 'unterminated",
    ] {
        let checked = policy
            .evaluate(Path::new("/bin/bash"), true, command)
            .unwrap();
        assert!(!checked.fully_parsed, "{command}: {checked:?}");
        assert!(!checked.all_commands_allowed);
        assert_eq!(checked.decision, Some(TerminalCommandDecision::Prompt));
        assert_eq!(checked.commands, vec![vec!["/bin/bash", "-lc", command]]);
        assert!(checked.matches.is_empty());
    }
    let checked = policy
        .evaluate(
            Path::new("/bin/sh"),
            false,
            "bash -lc 'git status > result'",
        )
        .unwrap();
    assert_eq!(
        checked.commands,
        vec![vec!["bash", "-lc", "git status > result"]]
    );
}

#[test]
fn strict_versioned_policy_round_trips_and_rejects_incorrect_inline_examples() {
    let mut entry = rule(&["git", "status"], TerminalCommandDecision::Allow);
    entry.matches.push(vec!["git".into(), "status".into()]);
    let policy = TerminalCommandPolicy::new(vec![entry.clone()]).unwrap();
    let restored = TerminalCommandPolicy::from_json(policy.to_json().unwrap().as_bytes()).unwrap();
    assert!(
        restored
            .evaluate(Path::new("/bin/sh"), false, "git status")
            .unwrap()
            .all_commands_allowed
    );
    entry.not_matches.push(vec!["git".into(), "status".into()]);
    assert!(TerminalCommandPolicy::new(vec![entry]).is_err());
    for text in [
        r#"{"version":2,"rules":[]}"#,
        r#"{"version":1,"rules":[],"unknown":true}"#,
    ] {
        assert!(TerminalCommandPolicy::from_json(text.as_bytes()).is_err());
    }
    assert!(TerminalCommandPolicy::from_json(&vec![b' '; MAX_POLICY_BYTES + 1]).is_err());
    let mut invalid = rule(&["git"], TerminalCommandDecision::Allow);
    invalid.pattern.push(TerminalCommandPattern::AnyOf(vec![]));
    assert!(TerminalCommandPolicy::new(vec![invalid]).is_err());
}
