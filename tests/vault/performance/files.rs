//! 真实磁盘的开库、重开和批量移动基准；夹具由临时目录自动清理。

use nous_core::{EntryMutation, Vault};
use std::{fs, time::Instant};
use tempfile::TempDir;

#[test]
#[ignore = "使用 --release --ignored --nocapture 显式测量，避免影响日常回归"]
fn open_and_move_notes() {
    let count = std::env::var("NOUS_FILES_BENCH_NOTES")
        .map_or(1000, |value| value.parse::<usize>().expect("笔记数量"));
    let batches = std::env::var("NOUS_FILES_BENCH_BATCHES").unwrap_or_else(|_| "10,100".into());
    let modes = std::env::var("NOUS_FILES_BENCH_MODES").unwrap_or_else(|_| "batch".into());
    let root = TempDir::new().unwrap();
    let index = TempDir::new().unwrap();
    fs::create_dir(root.path().join("archive")).unwrap();
    let paragraph = "文件管理需要保持原始内容和链接关系。Every operation preserves content, references, and recovery.\n\n";
    let mut bytes = 0;
    for note in 0..count {
        let body = format!(
            "# Note {note}\n\n[next](./{:05}.md)\n\n{}",
            (note + 1) % count,
            paragraph.repeat(12)
        );
        bytes += body.len();
        fs::write(root.path().join(format!("{note:05}.md")), body).unwrap();
    }
    let opened = Instant::now();
    let vault = Vault::open(root.path(), index.path()).unwrap();
    let first_open_ms = opened.elapsed().as_secs_f64() * 1000.0;
    let usable = Instant::now();
    assert!(vault.snapshot("00000.md").unwrap().disk.is_some());
    let first_read_ms = usable.elapsed().as_secs_f64() * 1000.0;
    drop(vault);
    let reopened = Instant::now();
    let vault = Vault::open(root.path(), index.path()).unwrap();
    let reopen_ms = reopened.elapsed().as_secs_f64() * 1000.0;
    let refreshed = Instant::now();
    assert!(!vault.refresh_index().unwrap());
    eprintln!(
        "{}",
        serde_json::json!({"notes": count, "bytes": bytes, "first_open_ms": first_open_ms,
            "first_read_ms": first_read_ms, "reopen_ms": reopen_ms,
            "unchanged_refresh_ms": refreshed.elapsed().as_secs_f64() * 1000.0})
    );
    for mode in modes.split(',') {
        assert!(matches!(mode, "single" | "batch"));
        for batch in batches
            .split(',')
            .map(|value| value.parse::<usize>().unwrap())
        {
            assert!(batch <= count);
            let changes: Vec<_> = (0..batch)
                .map(|note| EntryMutation {
                    from: format!("{note:05}.md"),
                    to: Some(format!("archive/{note:05}.md")),
                })
                .collect();
            let checked = Instant::now();
            vault.check_entry_batch(&changes).unwrap();
            let check_ms = checked.elapsed().as_secs_f64() * 1000.0;
            let started = Instant::now();
            if mode == "batch" {
                let outcome = vault.rename_batch(&changes, |_| Ok(true)).unwrap();
                assert_eq!(outcome.completed, batch);
                assert!(outcome.issue.is_none());
                assert!(outcome.warning.is_none());
            } else {
                for change in &changes {
                    let outcome = vault
                        .rename(&change.from, change.to.as_deref().unwrap())
                        .unwrap();
                    assert!(outcome.warning.is_none());
                }
            }
            let move_ms = started.elapsed().as_secs_f64() * 1000.0;
            assert_moved_contents(&vault, &changes, count, paragraph);
            eprintln!(
                "{}",
                serde_json::json!({"mode": mode, "batch": batch, "check_ms": check_ms, "move_ms": move_ms,
                "total_ms": move_ms + if mode == "single" { check_ms } else { 0.0 }})
            );
            // 在计时外恢复相同夹具，避免后续批次受前一轮的路径改写影响。
            for change in &changes {
                fs::rename(
                    root.path().join(change.to.as_ref().unwrap()),
                    root.path().join(&change.from),
                )
                .unwrap();
            }
            for note in 0..count {
                let path = format!("{note:05}.md");
                let body = format!(
                    "# Note {note}\n\n[next](./{:05}.md)\n\n{}",
                    (note + 1) % count,
                    paragraph.repeat(12)
                );
                fs::write(root.path().join(path), body).unwrap();
            }
            vault.refresh_index().unwrap();
        }
    }
}

// 校验放在计时外，证明每轮所有正文和链接均完整，避免以漏改链接换取性能。
fn assert_moved_contents(vault: &Vault, changes: &[EntryMutation], count: usize, paragraph: &str) {
    let batch = changes.len();
    assert_eq!(vault.list_files().unwrap().len(), count);
    for change in changes {
        assert!(!vault.root().join(&change.from).exists());
        assert!(vault.root().join(change.to.as_ref().unwrap()).exists());
    }
    for note in 0..count {
        let location = |number| {
            if number < batch {
                format!("archive/{number:05}.md")
            } else {
                format!("{number:05}.md")
            }
        };
        let path = location(note);
        let links = vault.links_from(&path).unwrap();
        assert_eq!(links.len(), 1);
        assert_eq!(
            links[0].to_path.as_deref(),
            Some(location((note + 1) % count).as_str())
        );
        assert!(vault
            .read(&path)
            .unwrap()
            .ends_with(paragraph.repeat(12).as_bytes()));
    }
}
