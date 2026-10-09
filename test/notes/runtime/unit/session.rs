//! 提交故障注入覆盖旧文件完整性、磁盘核对与临时文件回收。
use super::*;

#[test]
fn removed_reading_mode_does_not_survive_session_normalization() {
    let normalized = normalize(&json!({"reader": {
        "vaultRoot": "/notes", "currentPath": "note.md", "mode": "reading",
        "viewModes": {"note.md": "reading", "source.md": "source"}
    }}));
    assert!(normalized["reader"].get("mode").is_none());
    assert_eq!(
        normalized["reader"]["viewModes"],
        json!({"source.md": "source"})
    );
    assert_eq!(
        normalized["reader"]["documents"]["panes"][0]["currentPath"],
        "note.md"
    );
}


#[test]
fn reading_font_survives_reader_and_appearance_updates() {
    let data = tempfile::tempdir().unwrap();
    let store = SessionStore::new(data.path());
    assert_eq!(store.load()["readingFont"], "lora");
    for font in ["lora", "newsreader", "sans"] {
        store.patch(&json!({"readingFont": font})).unwrap();
        store
            .patch_reader(&json!({"vaultRoot": "/other", "documents": {}}))
            .unwrap();
        store.patch(&json!({"appearance": "dark"})).unwrap();
        assert_eq!(SessionStore::new(data.path()).load()["readingFont"], font);
    }
    for invalid in [Value::Null, json!("unknown"), json!({}), json!(12)] {
        assert_eq!(
            normalize(&json!({"readingFont": invalid}))["readingFont"],
            "lora"
        );
    }
}

#[test]
fn reading_palette_survives_reader_font_and_appearance_updates() {
    let data = tempfile::tempdir().unwrap();
    let store = SessionStore::new(data.path());
    assert_eq!(store.load()["readingPalette"], "monochrome");
    for palette in ["monochrome", "green"] {
        store.patch(&json!({"readingPalette": palette})).unwrap();
        store
            .patch_reader(&json!({"vaultRoot": "/other", "documents": {}}))
            .unwrap();
        store
            .patch(&json!({"readingFont": "newsreader", "appearance": "dark"}))
            .unwrap();
        assert_eq!(
            SessionStore::new(data.path()).load()["readingPalette"],
            palette
        );
    }
    for invalid in [Value::Null, json!("blue"), json!({}), json!(12), json!(true)] {
        assert_eq!(
            normalize(&json!({"readingPalette": invalid}))["readingPalette"],
            "monochrome"
        );
    }
}

#[test]
fn overflowing_numbers_do_not_discard_or_overwrite_valid_session_fields() {
    for number in ["1e400", "-1e400", &"9".repeat(400)] {
        let data = tempfile::tempdir().unwrap();
        let store = SessionStore::new(data.path());
        let input = format!(
            r#"{{"reader":{{"vaultRoot":"/notes","currentPath":"a.md","recentFiles":["a.md"],"leftWidth":{number}}},"window":{{"x":0,"y":0,"width":{number},"height":600}},"unknown":[{{"number":{number}}}]}}"#
        );
        fs::write(&store.file, input).unwrap();
        let loaded = store.load();
        assert_eq!(loaded["reader"]["vaultRoot"], "/notes");
        assert_eq!(
            loaded["reader"]["documents"]["panes"][0]["currentPath"],
            "a.md"
        );
        assert_eq!(loaded["reader"]["leftWidth"].as_f64(), Some(232.0));
        assert_eq!(loaded["window"], Value::Null);
        store.patch(&json!({"appearance": "dark"})).unwrap();
        let saved = store.load();
        assert_eq!(saved["appearance"], "dark");
        assert_eq!(saved["reader"], loaded["reader"]);
    }
}

#[test]
fn numeric_recovery_preserves_text_and_still_rejects_invalid_json() {
    let raw = br#"{"reader":{"vaultRoot":"/notes","currentPath":"1e400.md","history":{"back":[{"path":"a.md","position":{"source":{"offset":2,"before":"\ud800","after":"1e400"},"inset":0}}]}},"window":{"x":0,"y":0,"width":1e400,"height":600}}"#;
    let parsed = normalize(&parse_json(raw).unwrap());
    assert_eq!(parsed["reader"]["vaultRoot"], "/notes");
    let pane = &parsed["reader"]["documents"]["panes"][0];
    assert_eq!(pane["currentPath"], "1e400.md");
    assert_eq!(
        pane["history"]["back"][0]["position"]["source"]["before"],
        "�"
    );
    assert_eq!(
        pane["history"]["back"][0]["position"]["source"]["after"],
        "1e400"
    );
    for invalid in [
        r#"{"reader":{"vaultRoot":"/notes"},"width":1e400oops}"#,
        r#"{"width":1e400,}"#,
        r#"{"width":01e400}"#,
        r#"{"width":1e+}"#,
    ] {
        assert!(parse_json(invalid.as_bytes()).is_none(), "{invalid}");
    }
}

#[test]
fn javascript_surrogate_context_does_not_discard_the_workspace() {
    let input = br#"{"reader":{"vaultRoot":"/notes","currentPath":"a.md","history":{"back":[{"path":"a.md","position":{"source":{"offset":2,"before":"\ud800","after":"\ud83d\ude00"},"inset":0}}]}}}"#;
    let parsed = normalize(&parse_json(input).unwrap());
    assert_eq!(parsed["reader"]["vaultRoot"], "/notes");
    let context =
        &parsed["reader"]["documents"]["panes"][0]["history"]["back"][0]["position"]["source"];
    assert_eq!(context["before"], "�");
    assert_eq!(context["after"], "😀");
    assert!(parse_json(br#"{"reader": broken}"#).is_none());
    assert_eq!(
        parse_json(br#"{"literal":"\\ud800"}"#).unwrap()["literal"],
        "\\ud800"
    );
}

#[test]
fn floating_json_integer_keeps_the_second_active_pane() {
    let value =
        normalize(&json!({"reader":{"documents":{"panes":[{},{}],"active":1.0,"split":true}}}));
    assert_eq!(value["reader"]["documents"]["active"], 1);
    assert_eq!(value["reader"]["documents"]["split"], true);
}

#[test]
fn resource_session_failures_preserve_previous_file_and_clean_temporary() {
    for stage in [CommitStage::Write, CommitStage::Sync, CommitStage::Replace] {
        let data = tempfile::tempdir().unwrap();
        let store = SessionStore::new(data.path());
        store.patch(&json!({"appearance": "dark"})).unwrap();
        let previous = fs::read(&store.file).unwrap();
        let mut next = store.load();
        next["appearance"] = json!("light");
        let result = store.save_observed(&next, |at| {
            if at == stage {
                Err(std::io::Error::other("注入提交故障"))
            } else {
                Ok(())
            }
        });
        assert!(result.is_err(), "{stage:?}");
        assert_eq!(fs::read(&store.file).unwrap(), previous);
        assert_eq!(fs::read_dir(data.path()).unwrap().count(), 1);
        store.save(&next).unwrap();
        assert_eq!(store.load()["appearance"], "light");
    }
}

#[test]
fn resource_session_rechecks_disk_and_skips_unchanged_commits() {
    let data = tempfile::tempdir().unwrap();
    let store = SessionStore::new(data.path());
    for contents in [None, Some("{broken")] {
        if let Some(contents) = contents {
            fs::write(&store.file, contents).unwrap();
        }
        store.patch(&json!({})).unwrap();
        assert!(serde_json::from_slice::<Value>(&fs::read(&store.file).unwrap()).is_ok());
    }
    store.patch(&json!({"appearance": "dark"})).unwrap();
    let next = store.load();
    for _ in 0..50 {
        store
            .save_observed(&next, |_| panic!("相同会话不应进入写盘"))
            .unwrap();
    }
    fs::write(&store.file, "{\"appearance\":\"light\"}").unwrap();
    store.save(&next).unwrap();
    assert_eq!(store.load()["appearance"], "dark");
}

#[test]
fn damaged_fields_and_unicode_limits_match_reader_contract() {
    let value = normalize(
        &json!({"reader": {"space":"connections", "leftWidth":191, "recentFiles":["a",null,"a","b"],
        "documents":{"panes":[{"currentPath":"a", "position":{"source":{"offset":2,"before":"😀".repeat(33),"after":""},"inset":0}}, {}, {}],"active":7,"split":true},
        "fileTree":{"selected":["a","a","../bad"],"scroll":{"path":"a","offset":900}}}}),
    );
    assert_eq!(value["reader"]["recentFiles"], json!(["a", "b"]));
    assert!(value["reader"]["documents"]["panes"][0]
        .get("position")
        .is_none());
    assert_eq!(
        value["reader"]["documents"]["panes"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(value["reader"]["documents"]["active"], 0);
    assert_eq!(value["reader"]["fileTree"]["selected"], json!(["a"]));
    assert_eq!(
        value["reader"]["fileTree"]["scroll"]["offset"].as_f64(),
        Some(500.0)
    );
}

#[test]
fn workbench_preferences_survive_unrelated_patches() {
    let data = tempfile::tempdir().unwrap();
    let store = SessionStore::new(data.path());
    store.patch_reader(&json!({
        "destination": "library", "sidebarView": "search", "searchQuery": "设计",
        "documents": {"panes": [{"currentPath": "a.md", "outlineCollapsed": true}], "active": 0, "split": false}
    })).unwrap();
    store.patch(&json!({"appearance": "dark"})).unwrap();
    let reader = &store.load()["reader"];
    assert_eq!(reader["destination"], "library");
    assert_eq!(reader["sidebarView"], "search");
    assert_eq!(reader["searchQuery"], "设计");
    assert_eq!(reader["documents"]["panes"][0]["outlineCollapsed"], true);
}

#[test]
fn file_views_keep_separate_scroll_anchors_through_remap() {
    let data = tempfile::tempdir().unwrap();
    let store = SessionStore::new(data.path());
    store
        .patch_reader(&json!({"fileTree": {
            "expanded": ["old"], "selected": [], "focused": null,
            "scroll": {"path": "old/a.md", "offset": 8},
            "navigationScroll": {"path": "old/b.md", "offset": 3}
        }}))
        .unwrap();
    store.remap("old", Some("new")).unwrap();
    let loaded = store.load();
    assert_eq!(
        loaded["reader"]["fileTree"]["scroll"],
        json!({"path":"new/a.md","offset":8.0})
    );
    assert_eq!(
        loaded["reader"]["fileTree"]["navigationScroll"],
        json!({"path":"new/b.md","offset":3.0})
    );
}

#[test]
fn removed_graph_destination_restores_document_and_keeps_navigation() {
    let normalized = normalize(&json!({"reader": {
        "destination": "graph", "space": "connections", "sidebarView": "search",
        "searchQuery": "设计", "leftWidth": 260, "currentPath": "note.md", "vaultRoot": "/notes"
    }}));
    let reader = &normalized["reader"];
    assert_eq!(reader["destination"], "document");
    assert_eq!(reader["sidebarView"], "search");
    assert_eq!(reader["searchQuery"], "设计");
    assert_eq!(reader["leftWidth"].as_f64(), Some(260.0));
    assert_eq!(reader["documents"]["panes"][0]["currentPath"], "note.md");
}

#[test]
fn file_system_folder_and_legacy_boards_destination_survive_normalization() {
    let normalized = normalize(&json!({"reader": {
        "destination": "boards", "currentPath": "docs/note.md", "fileTree": {
            "expanded": [], "selected": ["docs/note.md"], "focused": "docs/note.md", "scroll": null,
            "browse": {"query": "", "section": "files", "directory": "docs"}
        }
    }}));
    assert_eq!(normalized["reader"]["destination"], "library");
    assert_eq!(normalized["reader"]["fileTree"]["browse"]["directory"], "docs");
    assert_eq!(normalized["reader"]["documents"]["panes"][0]["currentPath"], "docs/note.md");
}

#[test]
fn file_presentation_survives_restart_and_path_remap() {
    let data = tempfile::tempdir().unwrap();
    let store = SessionStore::new(data.path());
    let presentation = json!({"layout": "list", "sort": "modified", "preview": true});
    store
        .patch_reader(&json!({"fileTree": {
            "expanded": [], "selected": ["old/a.md"], "focused": "old/a.md", "scroll": null,
            "presentation": presentation,
            "browse": {"query": "", "section": "files", "directory": "old"}
        }}))
        .unwrap();
    store.remap("old", Some("new")).unwrap();
    let restored = SessionStore::new(data.path()).load();
    assert_eq!(restored["reader"]["fileTree"]["presentation"], presentation);
    assert_eq!(restored["reader"]["fileTree"]["browse"]["directory"], "new");
    let invalid = normalize(&json!({"reader": {"fileTree": {"presentation": {
        "layout": "cards", "sort": "name", "preview": true
    }}}}));
    assert!(invalid["reader"]["fileTree"].get("presentation").is_none());
}

#[test]
fn unified_workspace_preserves_navigation_and_discussion_identity_after_restart() {
    let data = tempfile::tempdir().unwrap();
    let store = SessionStore::new(data.path());
    store.patch_reader(&json!({
        "sidebarView": "files", "rightWidth": 420,
        "fileTree": {"expanded": ["old"], "selected": ["old/a.md"], "focused": "old/a.md", "scroll": null,
          "discussions": {"expanded": ["old/a.md", "\u{0}conversation:chat"], "archived": true,
            "scroll": {"key": "\u{0}conversation:chat", "offset": 12.5}}}
    })).unwrap();
    store.remap("old", Some("new")).unwrap();
    let reader = SessionStore::new(data.path()).load()["reader"].clone();
    assert_eq!(reader["sidebarView"], "files");
    assert_eq!(reader["rightWidth"].as_f64(), Some(420.0));
    assert_eq!(reader["fileTree"]["selected"], json!(["new/a.md"]));
    assert_eq!(reader["fileTree"]["discussions"], json!({
        "expanded": ["new/a.md", "\u{0}conversation:chat"], "archived": true,
        "scroll": {"key": "\u{0}conversation:chat", "offset": 12.5}
    }));
    store.remap("new/a.md", None).unwrap();
    let reader = store.load()["reader"].clone();
    assert_eq!(reader["fileTree"]["discussions"]["expanded"], json!(["\u{0}conversation:chat"]));
}
