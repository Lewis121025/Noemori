//! 首次建索引、热重开和外部批量变更的阶段基线；临时夹具随测试释放。
use nous_vault::{OpenPhase, Vault};
use std::{collections::BTreeMap, fs, time::Instant};
use tempfile::TempDir;

#[test]
#[ignore = "使用 --release --ignored --nocapture 显式测量开库"]
fn opening_phases() {
    let count = std::env::var("NOUS_OPEN_BENCH_NOTES")
        .map_or(1000, |value| value.parse::<usize>().unwrap());
    for sample in 0..3 {
        let root = TempDir::new().unwrap();
        let index = TempDir::new().unwrap();
        fs::create_dir(root.path().join("附件")).unwrap();
        for note in 0..count {
            fs::write(
                root.path().join(format!("{note:05}.md")),
                format!(
                    "---\ntags: [研究]\n---\n# 中文笔记 {note}\n\n[[{:05}]]\n\n{}",
                    (note + 1) % count,
                    "中文检索与原始资料。Mixed notes and links.\n\n".repeat(20)
                ),
            )
            .unwrap();
        }
        for asset in 0..count / 100 {
            fs::write(
                root.path().join(format!("附件/{asset}.bin")),
                vec![42; 128 * 1024],
            )
            .unwrap();
        }
        for mode in ["initial-index", "reopen", "external-batch"] {
            if mode == "external-batch" {
                for note in 0..count / 10 {
                    fs::write(
                        root.path().join(format!("{note:05}.md")),
                        format!("# 外部更新 {note}\n\nchanged 中文正文"),
                    )
                    .unwrap();
                }
            }
            let start = Instant::now();
            let mut phase = OpenPhase::Recovering;
            let mut changed = start;
            let mut stages = BTreeMap::<String, f64>::new();
            let vault = Vault::open_with_progress(root.path(), index.path(), &mut |progress| {
                if progress.phase != phase {
                    *stages.entry(format!("{phase:?}")).or_default() +=
                        changed.elapsed().as_secs_f64() * 1000.0;
                    changed = Instant::now();
                    phase = progress.phase;
                }
                if let Some(total) = progress.total {
                    assert!(progress.completed <= total);
                }
                Ok(true)
            })
            .unwrap();
            *stages.entry(format!("{phase:?}")).or_default() +=
                changed.elapsed().as_secs_f64() * 1000.0;
            assert!(vault.snapshot("00000.md").unwrap().disk.is_some());
            eprintln!(
                "{}",
                serde_json::json!({"mode": mode, "sample": sample, "notes": count, "attachments": count / 100, "total_ms": start.elapsed().as_secs_f64() * 1000.0, "stages_ms": stages})
            );
        }
    }
}
