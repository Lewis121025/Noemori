use super::TerminalInput;
use serde_json::{Value, json};

fn schema() -> jsonschema::Validator {
    jsonschema::options()
        .offline()
        .build(&serde_json::to_value(schemars::schema_for!(TerminalInput)).unwrap())
        .unwrap()
}

fn arguments(action: &str) -> Value {
    match action {
        "exec" => json!({"action":"exec","cmd":"true"}),
        "interact" => json!({"action":"interact","session_id":"owned-process"}),
        "stop" => json!({"action":"stop","session_id":"owned-process"}),
        _ => panic!("未知测试操作"),
    }
}

#[test]
fn declared_numeric_boundaries_match_execution_validation() {
    let schema = schema();
    for (action, field, min, max) in [
        ("exec", "yield_time_ms", 0_u64, 30_000_u64),
        ("interact", "yield_time_ms", 0, 300_000),
        ("exec", "max_output_chars", 256, 120_000),
        ("interact", "max_output_chars", 256, 120_000),
        ("exec", "timeout_ms", 1, 86_400_000),
    ] {
        let cases = [(min, true), (max, true), (max + 1, false)]
            .into_iter()
            .chain(min.checked_sub(1).map(|below| (below, false)));
        for (value, accepted) in cases {
            let mut input = arguments(action);
            input[field] = json!(value);
            assert_eq!(schema.is_valid(&input), accepted, "{input}");
            let input: TerminalInput = serde_json::from_value(input).unwrap();
            assert_eq!(input.validate().is_ok(), accepted, "{input:?}");
        }
    }
}

#[test]
fn text_budgets_count_unicode_characters_and_reject_invalid_commands() {
    let schema = schema();
    for (action, field, min, max) in [
        ("exec", "cmd", 1, 32_768),
        ("exec", "workdir", 1, 8_192),
        ("interact", "input", 0, 16_384),
        ("interact", "session_id", 1, 64),
        ("stop", "session_id", 1, 64),
    ] {
        for (length, accepted) in [(0, min == 0), (max, true), (max + 1, false)] {
            let mut input = arguments(action);
            input[field] = json!("中".repeat(length));
            assert_eq!(
                schema.is_valid(&input),
                accepted,
                "{action}.{field}: {length}"
            );
            let input: TerminalInput = serde_json::from_value(input).unwrap();
            assert_eq!(
                input.validate().is_ok(),
                accepted,
                "{action}.{field}: {length}"
            );
        }
    }
    // 结构合法仍不代表 shell 输入可执行，空白命令与 NUL 必须在启动前拒绝。
    for command in [" \n\t", "printf ok\0"] {
        let input: TerminalInput =
            serde_json::from_value(json!({"action":"exec","cmd":command})).unwrap();
        assert!(input.validate().unwrap_err().contains("cmd"));
    }
}
