#![cfg(target_os = "macos")]
#[path = "../../../../modules/agent/macos-ui/src/clipboard.rs"]
#[allow(dead_code)]
mod clipboard;
#[path = "../../../../modules/agent/macos-ui/src/paste-lifecycle.rs"]
#[allow(dead_code)]
mod paste_lifecycle;
use clipboard::{ClipboardTransaction, PasteContent};
use objc2_app_kit::NSPasteboard;
use objc2_foundation::{NSData, NSString};
use std::{path::Path, process::Command};

/// 所有测试仅操作独立 UUID 命名剪贴板，绝不修改用户的系统剪贴板。
fn isolated() -> objc2::rc::Retained<NSPasteboard> {
    NSPasteboard::pasteboardWithName(&NSString::from_str(&format!(
        "app.noemori.test.{}",
        uuid::Uuid::new_v4()
    )))
}
fn content() -> PasteContent<'static> {
    PasteContent {
        text: "中文🙂",
        html: Some("<b>中文🙂</b>"),
        rtf: Some("{\\rtf1 content}"),
    }
}

#[test]
fn failed_write_after_clear_restores_original_formats() {
    let board = isolated();
    let format = NSString::from_str("app.noemori.test.original");
    assert!(board.setData_forType(Some(&NSData::from_vec(vec![0, 1, 2, 255])), &format));
    let mut transaction = ClipboardTransaction::prepare(board.clone()).unwrap();
    assert!(
        transaction
            .install_using(content(), |_, _| Err("模拟系统写入失败".into()))
            .is_err()
    );
    assert!(
        transaction.restore().unwrap(),
        "清空后未被他人修改的剪贴板仍属于本次事务"
    );
    assert_eq!(
        board.dataForType(&format).unwrap().to_vec(),
        vec![0, 1, 2, 255]
    );
    board.clearContents();
}

#[test]
fn installed_text_html_rtf_are_real_formats_and_restore_original_bytes() {
    let board = isolated();
    let format = NSString::from_str("app.noemori.test.original");
    assert!(board.setData_forType(Some(&NSData::from_vec(vec![5, 9, 0])), &format));
    let mut transaction = ClipboardTransaction::prepare(board.clone()).unwrap();
    transaction.install(content()).unwrap();
    transaction.require_owned().unwrap();
    for (format, expected) in [
        ("public.utf8-plain-text", "中文🙂"),
        ("public.html", "\u{feff}<b>中文🙂</b>"),
        ("public.rtf", "{\\rtf1 content}"),
    ] {
        assert_eq!(
            board
                .dataForType(&NSString::from_str(format))
                .unwrap()
                .to_vec(),
            expected.as_bytes()
        );
    }
    assert!(transaction.restore().unwrap());
    assert_eq!(board.dataForType(&format).unwrap().to_vec(), vec![5, 9, 0]);
    board.clearContents();
}

#[test]
fn unicode_html_is_consumed_with_exact_text_and_real_formatting() {
    let consumer = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../test/agent/ui/support/ClipboardConsumer.swift");
    for html in [
        "<b>中文🙂</b>",
        "\u{feff}<b>中文🙂</b>",
        "<meta charset=\"windows-1252\"><b>中文🙂</b>",
    ] {
        let board = isolated();
        let mut transaction = ClipboardTransaction::prepare(board.clone()).unwrap();
        transaction
            .install(PasteContent {
                text: "中文🙂",
                html: Some(html),
                rtf: None,
            })
            .unwrap();
        let result = Command::new("xcrun")
            .arg("swift")
            .arg(&consumer)
            .arg(board.name().to_string())
            .output()
            .unwrap();
        let bytes = board
            .dataForType(&NSString::from_str("public.html"))
            .unwrap()
            .to_vec();
        assert!(transaction.restore().unwrap());
        board.clearContents();
        assert!(
            result.status.success(),
            "真实 AppKit 消费失败：{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let actual: serde_json::Value = serde_json::from_slice(&result.stdout).unwrap();
        assert_eq!(actual["consumed"], true, "{actual}");
        assert_eq!(actual["text"], "中文🙂", "HTML：{html:?}；{actual}");
        assert_eq!(actual["bold"], true, "{actual}");
        assert!(bytes.starts_with(b"\xef\xbb\xbf"));
        assert!(!bytes[3..].starts_with(b"\xef\xbb\xbf"));
    }
}

#[test]
fn user_clipboard_change_during_install_is_preserved() {
    let board = isolated();
    let mut transaction = ClipboardTransaction::prepare(board.clone()).unwrap();
    transaction.install(content()).unwrap();
    board.clearContents();
    let format = NSString::from_str("public.utf8-plain-text");
    assert!(board.setData_forType(Some(&NSData::from_vec(b"user".to_vec())), &format));
    assert!(transaction.require_owned().is_err());
    assert!(!transaction.restore().unwrap());
    assert_eq!(board.dataForType(&format).unwrap().to_vec(), b"user");
    board.clearContents();
}

#[test]
fn changed_clipboard_before_install_is_never_overwritten() {
    let board = isolated();
    let mut transaction = ClipboardTransaction::prepare(board.clone()).unwrap();
    board.clearContents();
    assert!(board.setData_forType(
        Some(&NSData::from_vec(b"new".to_vec())),
        &NSString::from_str("public.utf8-plain-text")
    ));
    assert!(transaction.install(content()).is_err());
    assert!(transaction.restore().unwrap());
    assert_eq!(
        board
            .dataForType(&NSString::from_str("public.utf8-plain-text"))
            .unwrap()
            .to_vec(),
        b"new"
    );
    board.clearContents();
}

#[test]
fn another_helper_cannot_snapshot_pending_payload_as_user_clipboard() {
    let board = isolated();
    let format = NSString::from_str("app.noemori.test.original");
    assert!(board.setData_forType(Some(&NSData::from_vec(vec![9, 0, 255])), &format));
    let mut original = ClipboardTransaction::prepare(board.clone()).unwrap();
    original.install(content()).unwrap();
    assert!(
        ClipboardTransaction::prepare(board.clone()).is_err(),
        "另一个 helper 必须尊重原事务的完整用户材料"
    );
    assert!(original.restore().unwrap());
    assert_eq!(
        board.dataForType(&format).unwrap().to_vec(),
        vec![9, 0, 255]
    );
    assert!(ClipboardTransaction::prepare(board.clone()).is_ok());
    board.clearContents();
}
