use super::{scan_identity_strict, scan_markdown_strict};

#[test]
fn export_identity_preserves_first_nonempty_heading_and_alias_semantics() {
    for (source, expected) in [
        ("# 第一标题\n\n## 第二标题\n", vec!["第一标题"]),
        (
            "---\naliases: [甲, 乙, 甲]\n---\n# 中文\n",
            vec!["中文", "甲", "乙"],
        ),
        ("#\n\n> ## 引用标题\n", vec!["引用标题"]),
        ("```md\n# 代码标题\n```\n\n纯正文\n", vec![]),
        ("---\nalias: 'A, B, A'\n---\n", vec!["A", "B"]),
        ("# 含有[链接](target.md)\n", vec!["含有链接"]),
    ] {
        assert_eq!(scan_identity_strict(source).unwrap(), expected);
    }
}

#[test]
fn export_identity_matches_index_semantics_for_one_thousand_content_combinations() {
    let mut seed = 19_491_001_u32;
    for index in 0..1000 {
        seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        let header = if seed & 1 == 0 {
            format!("---\naliases: [别名{index}, 同名, 同名]\ntags: [标签]\n---\n")
        } else {
            String::new()
        };
        let title = if seed & 2 == 0 {
            format!("# 标题{index} *强调*\n")
        } else {
            format!("> ## 引用{index}\n")
        };
        let source = format!("{header}\n```md\n# 非标题\n```\n\n{title}\n正文 [引用][ref] [[链接]] $x^2$ 😀。\n\n| 表头 |\n| --- |\n| 内容 |\n\n## 后续标题\n\n[ref]: target.md\n");
        let full = scan_markdown_strict("a.md", &source).unwrap();
        assert_eq!(
            scan_identity_strict(&source).unwrap(),
            crate::links::identity::keys_from_scan(&full),
            "{index}"
        );
    }
}
