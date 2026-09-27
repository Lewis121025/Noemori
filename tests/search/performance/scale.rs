//! 显式运行的大库基准；使用真实文件扫描、排名索引与 `SQLite` 正文查询，退出时清理临时库。
//! `NOUS_SEARCH_BENCH_NOTES` 可缩小诊断规模；默认 100000 篇、约 1 GB。

use nous_core::{Error, SearchCancellation, SearchExpr, SearchQuery, Vault};
use std::{
    fmt::Write as _,
    fs, thread,
    time::{Duration, Instant},
};
use tempfile::TempDir;

#[test]
#[ignore = "生成 10 万篇真实文件；使用 --release --ignored --nocapture 显式运行"]
fn hundred_thousand_notes() {
    let count = std::env::var("NOUS_SEARCH_BENCH_NOTES")
        .map_or(100_000, |value| value.parse::<usize>().expect("笔记数量"));
    assert!(count > 0, "基准笔记数必须大于零");
    let root = TempDir::new().unwrap();
    let index = TempDir::new().unwrap();
    let started = Instant::now();
    let bytes = generate_corpus(root.path(), count);
    eprintln!(
        "corpus notes={count} bytes={bytes} generated_s={:.2}",
        started.elapsed().as_secs_f64()
    );
    let opened = Instant::now();
    let vault = Vault::open(root.path(), index.path()).unwrap();
    eprintln!("index_s={:.2}", opened.elapsed().as_secs_f64());
    let mut failures = measure_queries(&vault, count);
    if let Some(failure) = measure_paging(&vault, count) {
        failures.push(failure);
    }
    if let Some(failure) = measure_cancellation(&vault, count) {
        failures.push(failure);
    }
    if let Some(failure) = measure_after_edit(&vault, root.path()) {
        failures.push(failure);
    }
    eprintln!("index_and_wal_bytes={}", directory_bytes(index.path()));
    let conn = rusqlite::Connection::open(index.path().join("index.sqlite")).unwrap();
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
        .unwrap();
    eprintln!("index_checkpointed_bytes={}", directory_bytes(index.path()));
    assert!(
        failures.is_empty(),
        "超过内核查询 150ms 预算：{}",
        failures.join(", ")
    );
}

/// 续页重复请求不缓存命中，完整测量排名、正文验证与摘要；第一页结果不能在续页重复。
fn measure_paging(vault: &Vault, count: usize) -> Option<String> {
    if count <= 100 {
        return None;
    }
    let query = SearchQuery {
        expr: SearchExpr::Term("archive".into()),
        limit: 100,
    };
    let token = SearchCancellation::default();
    let first = vault.search_page(&query, None, &token).unwrap();
    let cursor = first.next_cursor.unwrap();
    let mut samples = Vec::new();
    for _ in 0..20 {
        let start = Instant::now();
        let page = vault.search_page(&query, Some(&cursor), &token).unwrap();
        samples.push(start.elapsed().as_secs_f64() * 1000.0);
        assert_eq!(page.hits.len(), (count - 100).min(100));
        assert!(page
            .hits
            .iter()
            .all(|hit| first.hits.iter().all(|old| old.path != hit.path)));
        std::hint::black_box(page);
    }
    samples.sort_by(f64::total_cmp);
    let p95 = samples[18];
    eprintln!("second_page: p50_ms={:.2} p95_ms={p95:.2}", samples[9]);
    (p95 > 150.0).then(|| format!("续页 P95={p95:.2}ms"))
}

/// 对需要扫描整库的查询测量发出取消后的退出时间，取消不能伪装成空结果。
fn measure_cancellation(vault: &Vault, count: usize) -> Option<String> {
    // 极小的诊断样本可能在发出取消前就完成，不能用它测量在途取消。
    if count < 1000 {
        return None;
    }
    let token = SearchCancellation::default();
    let elapsed = thread::scope(|scope| {
        let task = scope.spawn(|| {
            vault.search_page(
                &SearchQuery {
                    expr: SearchExpr::Or(vec![
                        SearchExpr::Term("neverpresentalpha".into()),
                        SearchExpr::Regex("neverpresentbeta".into()),
                    ]),
                    limit: 100,
                },
                None,
                &token,
            )
        });
        thread::sleep(Duration::from_millis(20));
        let start = Instant::now();
        token.cancel();
        assert!(matches!(task.join().unwrap(), Err(Error::SearchCancelled)));
        start.elapsed().as_secs_f64() * 1000.0
    });
    eprintln!("cancel_full_scan_ms={elapsed:.2}");
    (elapsed > 150.0).then(|| format!("取消全文扫描={elapsed:.2}ms"))
}

/// 计入排名引擎的所有段文件，避免只测 `SQLite` 而低估真实占用。
fn directory_bytes(path: &std::path::Path) -> u64 {
    fs::read_dir(path)
        .unwrap()
        .map(|entry| {
            let entry = entry.unwrap();
            if entry.file_type().unwrap().is_dir() {
                directory_bytes(&entry.path())
            } else {
                entry.metadata().unwrap().len()
            }
        })
        .sum()
}

/// 生成中英混合的真实 Markdown 文件，稀有条件按固定间隔分布。
fn generate_corpus(root: &std::path::Path, count: usize) -> usize {
    let mut bytes = 0;
    for folder in 0..count.div_ceil(1000) {
        fs::create_dir(root.join(format!("{folder:03}"))).unwrap();
    }
    for note in 0..count {
        let mut body = format!("# 研究记录 {note}\n\n");
        for paragraph in 0..55 {
            write!(body, "研究记录 {note:06} 第 {paragraph:02} 段：讨论设计原则、数据库事务、阅读体验与长期维护。The archive records observations, experiments, and implementation details for project {:08x}.\n\n", note.wrapping_mul(2_654_435_761) ^ paragraph).unwrap();
        }
        if note % 997 == 0 {
            body.push_str("量子 quantumneedle 预算 审批\n");
        }
        body.truncate(
            body.char_indices()
                .take_while(|(offset, _)| *offset <= 10_000)
                .last()
                .map_or(0, |(offset, _)| offset),
        );
        // 标记放在固定大小正文后，确保不会被裁掉。
        if note % 997 == 0 {
            body.push_str("量子 quantumneedle 预算 审批\n");
        }
        bytes += body.len();
        fs::write(root.join(format!("{:03}/{note:06}.md", note / 1000)), body).unwrap();
    }
    bytes
}

/// 每类查询都验证真实结果数量；固定 20 次重复样本计算 P95，不缓存查询结果。
fn measure_queries(vault: &Vault, count: usize) -> Vec<String> {
    let cases = [
        (
            "英文稀有词",
            SearchExpr::Term("quantumneedle".into()),
            count.div_ceil(997).min(100),
        ),
        (
            "中文双字",
            SearchExpr::Term("量子".into()),
            count.div_ceil(997).min(100),
        ),
        ("双字无结果", SearchExpr::Term("稀缺".into()), 0),
        ("常见词", SearchExpr::Term("archive".into()), count.min(100)),
        (
            "常见三字片段",
            SearchExpr::Term("arc".into()),
            count.min(100),
        ),
        (
            "常见多词",
            SearchExpr::And(vec![
                SearchExpr::Term("archive".into()),
                SearchExpr::Term("implementation".into()),
            ]),
            count.min(100),
        ),
        (
            "常见词与稀有短词",
            SearchExpr::And(vec![
                SearchExpr::Term("archive".into()),
                SearchExpr::Term("量子".into()),
            ]),
            count.div_ceil(997).min(100),
        ),
        (
            "片段存在但短语不存在",
            SearchExpr::Term("archive experiments".into()),
            0,
        ),
        (
            "同一行条件",
            SearchExpr::Line(Box::new(SearchExpr::And(vec![
                SearchExpr::Term("预算".into()),
                SearchExpr::Term("审批".into()),
            ]))),
            count.div_ceil(997).min(100),
        ),
    ];
    let mut failures = Vec::new();
    for (label, expr, expected) in cases.into_iter().chain(boolean_cases(count)) {
        let query = SearchQuery { expr, limit: 100 };
        let first = Instant::now();
        assert_eq!(vault.search(&query).unwrap().len(), expected);
        let first_ms = first.elapsed().as_secs_f64() * 1000.0;
        let mut samples = Vec::new();
        for _ in 0..20 {
            let start = Instant::now();
            let hits = vault.search(&query).unwrap();
            assert_eq!(hits.len(), expected);
            std::hint::black_box(hits);
            samples.push(start.elapsed().as_secs_f64() * 1000.0);
        }
        samples.sort_by(f64::total_cmp);
        let p95 = samples[18];
        eprintln!(
            "{label}: first_ms={first_ms:.2} p50_ms={:.2} p95_ms={p95:.2}",
            samples[9]
        );
        if p95 > 150.0 {
            failures.push(format!("{label} P95={p95:.2}ms"));
        }
    }
    failures
}

/// 布尔查询单独覆盖空集、并集去重及分支内混合索引，不改变统一延迟预算。
fn boolean_cases(count: usize) -> [(&'static str, SearchExpr, usize); 6] {
    [
        (
            "OR 无结果",
            SearchExpr::Or(vec![
                SearchExpr::Term("neverpresentalpha".into()),
                SearchExpr::Term("neverpresentbeta".into()),
            ]),
            0,
        ),
        (
            "OR 稀有词",
            SearchExpr::Or(vec![
                SearchExpr::Term("quantumneedle".into()),
                SearchExpr::Term("neverpresentbeta".into()),
            ]),
            count.div_ceil(997).min(100),
        ),
        (
            "OR 长短词混合",
            SearchExpr::Or(vec![
                SearchExpr::Term("quantumneedle".into()),
                SearchExpr::Term("稀缺".into()),
            ]),
            count.div_ceil(997).min(100),
        ),
        (
            "OR 中文短词",
            SearchExpr::Or(vec![
                SearchExpr::Term("量子".into()),
                SearchExpr::Term("稀缺".into()),
            ]),
            count.div_ceil(997).min(100),
        ),
        (
            "OR 常见词",
            SearchExpr::Or(vec![
                SearchExpr::Term("archive".into()),
                SearchExpr::Term("observations".into()),
            ]),
            count.min(100),
        ),
        (
            "OR 分支内筛选",
            SearchExpr::Or(vec![
                SearchExpr::And(vec![
                    SearchExpr::Term("archive".into()),
                    SearchExpr::Term("量子".into()),
                ]),
                SearchExpr::And(vec![
                    SearchExpr::Term("implementation".into()),
                    SearchExpr::Term("稀缺".into()),
                ]),
            ]),
            count.div_ceil(997).min(100),
        ),
    ]
}

/// 外部修改后首次查询包含排名索引同步，防止静态资料库指标掩盖真实编辑成本。
fn measure_after_edit(vault: &Vault, root: &std::path::Path) -> Option<String> {
    let path = root.join("000/000000.md");
    let mut source = fs::read_to_string(&path).unwrap();
    source.push_str("\n\nincrementalprobe\n");
    fs::write(&path, source).unwrap();
    let refresh = Instant::now();
    assert!(vault.refresh_index().unwrap());
    let refresh_ms = refresh.elapsed().as_secs_f64() * 1000.0;
    let start = Instant::now();
    let hits = vault
        .search(&SearchQuery {
            expr: SearchExpr::Term("incrementalprobe".into()),
            limit: 100,
        })
        .unwrap();
    let elapsed = start.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].path, "000/000000.md");
    assert!(hits[0].matches[0].location.is_some());
    eprintln!("after_edit: refresh_ms={refresh_ms:.2} first_query_and_sync_ms={elapsed:.2}");
    (elapsed > 150.0).then(|| format!("编辑后首次查询含索引同步={elapsed:.2}ms"))
}
