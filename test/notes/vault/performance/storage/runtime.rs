//! 相同语料下测量完整内核操作；包含真实 fsync、链接改写与精确全文定位。
use noemori_vault::{EntryMutation, SearchExpr, SearchQuery, Vault, WriteOutcome};
use serde_json::json;
use std::{fs, time::Instant};

fn measure<T>(samples: usize, name: &str, mut operation: impl FnMut(usize) -> T) {
    if std::env::var("NOEMORI_RUNTIME_BENCH_OPERATIONS")
        .is_ok_and(|selected| !selected.split(',').any(|item| item == name))
    {
        return;
    }
    let mut times = Vec::with_capacity(samples);
    for index in 0..samples {
        let start = Instant::now();
        std::hint::black_box(operation(index));
        times.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    times.sort_by(f64::total_cmp);
    eprintln!(
        "{}",
        json!({"operation": name, "samples": samples, "p50_ms": times[(samples - 1) / 2],
        "p95_ms": times[(samples * 95).div_ceil(100) - 1], "p99_ms": times[(samples * 99).div_ceil(100) - 1]})
    );
}

#[test]
#[ignore = "同机串行使用 --release --ignored --nocapture 测量，不与其他测试并跑"]
fn complete_operations() {
    let count =
        std::env::var("NOEMORI_RUNTIME_BENCH_NOTES").map_or(1000, |n| n.parse::<usize>().unwrap());
    let samples =
        std::env::var("NOEMORI_RUNTIME_BENCH_SAMPLES").map_or(100, |n| n.parse::<usize>().unwrap());
    assert!(count >= 100 && samples >= 30);
    let root = tempfile::tempdir().unwrap();
    let index = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("archive")).unwrap();
    for i in 0..count {
        fs::write(
            root.path().join(format!("{i:05}.md")),
            format!(
                "# Note {i}\n\n[next](./{:05}.md)\n\n{}{}",
                (i + 1) % count,
                "中文全文定位与内容完整性。The archive preserves references and recovery.\n"
                    .repeat(16),
                if i % 997 == 0 {
                    "quantumneedle 量子"
                } else {
                    ""
                }
            ),
        )
        .unwrap();
    }
    let vault = Vault::open(root.path(), index.path()).unwrap();
    eprintln!(
        "{}",
        json!({"notes":count,"architecture":std::env::consts::ARCH,"os":std::env::consts::OS})
    );
    measure(samples, "warm_read", |_| vault.read("00000.md").unwrap());
    measure(samples, "warm_links", |_| {
        let result = vault.links_to("00000.md").unwrap();
        assert_eq!(result.len(), 1);
        result
    });
    let mut expected = None;
    measure(samples, "durable_save", |i| {
        let next = format!("# Saved\nrevision {i}").into_bytes();
        let result = vault.write("saved.md", &next, expected.as_deref()).unwrap();
        assert!(matches!(result, WriteOutcome::Saved { warning: None }));
        expected = Some(next);
    });
    measure(samples, "rename_with_links", |i| {
        let (from, to) = if i % 2 == 0 {
            ("00000.md", "renamed.md")
        } else {
            ("renamed.md", "00000.md")
        };
        assert!(vault.rename(from, to).unwrap().warning.is_none());
    });
    measure(samples, "batch_10", |i| {
        let changes: Vec<_> = (1..=10)
            .map(|n| {
                let name = format!("{n:05}.md");
                let target = format!("archive/{name}");
                let (from, to) = if i % 2 == 0 {
                    (name, target)
                } else {
                    (target, name)
                };
                EntryMutation { from, to: Some(to) }
            })
            .collect();
        let result = vault.rename_batch(&changes, |_| Ok(true)).unwrap();
        assert_eq!(result.completed, 10);
        assert!(result.issue.is_none());
        assert!(result.warning.is_none());
    });
    measure_queries(&vault, count, samples);
    measure(samples, "save_and_first_search", |i| {
        let next = format!("# Saved\nrevision {i} uniquefreshprobe").into_bytes();
        assert!(matches!(
            vault.write("saved.md", &next, expected.as_deref()).unwrap(),
            WriteOutcome::Saved { warning: None }
        ));
        expected = Some(next);
        let result = vault
            .search(&SearchQuery {
                expr: SearchExpr::Term("uniquefreshprobe".into()),
                limit: 100,
            })
            .unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].path, "saved.md");
    });
    let rss = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &std::process::id().to_string()])
        .output()
        .unwrap();
    eprintln!(
        "{}",
        json!({"rss_kib": String::from_utf8_lossy(&rss.stdout).trim()})
    );
}

fn measure_queries(vault: &Vault, count: usize, samples: usize) {
    for (label, term) in [
        ("rare_search", "quantumneedle"),
        ("chinese_search", "量子"),
        ("common_search", "archive"),
    ] {
        let query = SearchQuery {
            expr: SearchExpr::Term(term.into()),
            limit: 100,
        };
        let expected = if term == "archive" {
            100
        } else {
            count.div_ceil(997)
        };
        assert_eq!(vault.search(&query).unwrap().len(), expected);
        measure(samples, label, |_| {
            let result = vault.search(&query).unwrap();
            assert_eq!(result.len(), expected);
            result
        });
    }
}
