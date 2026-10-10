#[path = "../../../../modules/agent/macos-ui/src/observation.rs"]
mod observation;
use serde_json::{Value, json};

fn snapshot(id: &str) -> Value {
    json!({"id":id,"window":"window","title":"窗口","bounds":{"x":1,"y":2,"width":100,"height":200},"elements":[{"ref":"e0","name":"按钮"}],"warnings":[],"truncated":false})
}

#[test]
fn delta_replaces_fields_and_reconstructs_the_new_snapshot() {
    let previous = snapshot("before");
    let mut current = snapshot("after");
    current["elements"] = json!([{"ref":"e0","name":"新按钮"}]);
    current["warnings"] = json!(["AX 预算耗尽"]);
    current["truncated"] = json!(true);
    let result = observation::result(Some(&previous), &current, "delta", Some("before")).unwrap();
    assert!(result.get("observation").is_none());
    let update = &result["observation_update"];
    assert_eq!(update["kind"], "delta");
    assert_eq!(update["truncated"], true);
    let mut restored = previous;
    for (key, value) in update["changes"].as_object().unwrap() {
        restored[key] = value.clone();
    }
    restored["id"] = update["id"].clone();
    assert_eq!(restored, current);
}

#[test]
fn unchanged_has_a_new_identity_without_repeating_ax_content() {
    let result = observation::result(
        Some(&snapshot("before")),
        &snapshot("after"),
        "delta",
        Some("before"),
    )
    .unwrap();
    assert_eq!(
        result,
        json!({"observation_update":{"kind":"unchanged","id":"after","target":"window","base":"before","truncated":false,"changes":{}}})
    );
}

#[test]
fn missing_invalidated_and_mismatched_baselines_return_explicit_full_results() {
    let previous = snapshot("before");
    for (saved, baseline, reason) in [
        (Some(&previous), None, "missing_baseline"),
        (None, Some("before"), "invalidated"),
        (Some(&previous), Some("old"), "baseline_mismatch"),
    ] {
        let current = snapshot("after");
        let result = observation::result(saved, &current, "delta", baseline).unwrap();
        assert_eq!(result["observation"], current);
        assert_eq!(result["observation_update"]["reset_reason"], reason);
    }
    let mut other = previous;
    other["window"] = json!("other");
    assert_eq!(
        observation::result(Some(&other), &snapshot("after"), "delta", Some("before")).unwrap()["observation_update"]
            ["reset_reason"],
        "invalidated"
    );
}

#[test]
fn full_observation_remains_compatible_and_invalid_modes_are_rejected() {
    let current = snapshot("after");
    assert_eq!(
        observation::result(None, &current, "full", None).unwrap(),
        json!({"observation":current})
    );
    assert!(observation::result(None, &current, "none", None).is_err());
}

#[test]
fn host_input_contracts_preserve_observation_options_and_reject_invalid_modes() {
    use noemori_agent::tool::{browser::BrowserInput, ui::computer::ComputerInput};
    for mode in ["full", "delta", "none"] {
        let value = json!({"action":"fill","page":"page","observation":"before","ref":"e0","text":"文字","observation_mode":mode});
        let input: BrowserInput = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(input).unwrap(), value);
        let value = json!({"action":"set_value","app":"app","window":"window","observation":"before","ref":"e0","value":"文字","observation_mode":mode});
        let input: ComputerInput = serde_json::from_value(value.clone()).unwrap();
        input.validate().unwrap();
        assert_eq!(serde_json::to_value(input).unwrap(), value);
    }
    let value = json!({"action":"observe","page":"page","mode":"delta","baseline":"before"});
    let input: BrowserInput = serde_json::from_value(value.clone()).unwrap();
    assert_eq!(serde_json::to_value(input).unwrap(), value);
    assert!(
        serde_json::from_value::<BrowserInput>(
            json!({"action":"observe","page":"page","mode":"none"})
        )
        .is_err()
    );
    assert!(
        serde_json::from_value::<ComputerInput>(json!({"action":"permissions","mode":"delta"}))
            .unwrap()
            .validate()
            .is_err()
    );
}

#[test]
fn typed_host_output_keeps_empty_replacement_arrays_and_false_truncation() {
    use noemori_agent::tool::browser::BrowserOutput;
    let value = json!({"outcome":"observed","tabs":[],"mode":"agent","observation_update":{"kind":"delta","id":"after","target":"page","base":"before","truncated":false,"changes":{"elements":[],"warnings":[],"truncated":false}}});
    let input: BrowserOutput = serde_json::from_value(value).unwrap();
    let result = serde_json::to_value(input).unwrap();
    assert_eq!(
        result["observation_update"]["changes"],
        json!({"elements":[],"warnings":[],"truncated":false})
    );
    assert!(result.get("observation").is_none());
}
