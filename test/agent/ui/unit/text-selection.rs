#[path = "../../../../modules/agent/macos-ui/src/text-selection.rs"]
mod selection;
use selection::{TextRange, TextSelection, byte_range, locate};

fn spec(text: &str) -> TextSelection<'_> {
    TextSelection {
        text,
        prefix: None,
        suffix: None,
        position: "select",
    }
}

#[test]
fn unicode_text_uses_ax_utf16_offsets() {
    let range = locate("前🙂中文🙂后", spec("中文🙂")).unwrap();
    assert_eq!(
        range,
        TextRange {
            location: 3,
            length: 4
        }
    );
    assert_eq!(
        &"前🙂中文🙂后"[byte_range("前🙂中文🙂后", range).unwrap()],
        "中文🙂"
    );
}

#[test]
fn prefix_suffix_disambiguate_and_caret_does_not_expand_selection() {
    let mut selection = spec("名字");
    assert!(locate("甲名字乙 甲名字丙", selection).is_err());
    selection.prefix = Some("甲");
    selection.suffix = Some("丙");
    assert_eq!(
        locate("甲名字乙 甲名字丙", selection).unwrap(),
        TextRange {
            location: 6,
            length: 2
        }
    );
    selection.position = "before";
    assert_eq!(
        locate("甲名字乙 甲名字丙", selection).unwrap(),
        TextRange {
            location: 6,
            length: 0
        }
    );
    selection.position = "after";
    assert_eq!(
        locate("甲名字乙 甲名字丙", selection).unwrap(),
        TextRange {
            location: 8,
            length: 0
        }
    );
}

#[test]
fn overlapping_empty_missing_and_invalid_targets_fail() {
    assert!(locate("aaa", spec("aa")).is_err());
    assert!(locate("aaa", spec("")).is_err());
    assert!(locate("aaa", spec("bbb")).is_err());
    assert!(
        locate(
            "aaa",
            TextSelection {
                position: "first",
                ..spec("aaa")
            }
        )
        .is_err()
    );
}

#[test]
fn byte_mapping_rejects_surrogate_splits_overflow_and_out_of_bounds() {
    for range in [
        TextRange {
            location: 1,
            length: 0,
        },
        TextRange {
            location: 0,
            length: 1,
        },
        TextRange {
            location: 3,
            length: 0,
        },
        TextRange {
            location: usize::MAX,
            length: 1,
        },
    ] {
        assert!(byte_range("🙂", range).is_err());
    }
    assert_eq!(
        byte_range(
            "🙂",
            TextRange {
                location: 2,
                length: 0
            }
        )
        .unwrap(),
        4..4
    );
}
