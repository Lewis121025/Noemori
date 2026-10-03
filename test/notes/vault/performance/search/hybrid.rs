//! 图索引基准使用可复现低维流形，区分近邻召回率与模型语义相关性。

use super::*;
use std::time::Instant;
use tempfile::TempDir;
use usearch::{Index, IndexOptions, MetricKind, ScalarKind};

fn vector(seed: u64) -> Vec<f32> {
    let mut values = vec![0.0; model::DIMENSIONS];
    let mut state = seed + 1;
    for value in values.iter_mut().take(16) {
        state = state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1);
        *value = f32::from(u16::try_from(state >> 48).unwrap()) / 65535.0;
    }
    model::normalize(&values).unwrap()
}

#[test]
#[ignore = "显式测量 640 维 HNSW 的召回率、查询与存储成本"]
fn hnsw_scale() {
    let count = std::env::var("NOEMORI_VECTOR_BENCH_CHUNKS")
        .map_or(100_000, |v| v.parse::<usize>().unwrap());
    let root = TempDir::new().unwrap();
    let index = Index::new(&IndexOptions {
        dimensions: model::DIMENSIONS,
        metric: MetricKind::Cos,
        quantization: ScalarKind::F32,
        connectivity: 16,
        expansion_add: 200,
        expansion_search: 400,
        multi: false,
    })
    .unwrap();
    index.reserve(count).unwrap();
    let start = Instant::now();
    for id in 0..count {
        index
            .add(
                u64::try_from(id).unwrap(),
                &vector(u64::try_from(id).unwrap()),
            )
            .unwrap();
    }
    let build = start.elapsed();
    let mut latencies = Vec::new();
    let mut recall = 0.0;
    for seed in 0..20_u32 {
        let query = vector(u64::try_from(count).unwrap() + u64::from(seed));
        let expected = index
            .exact_search(&query, 100)
            .unwrap()
            .keys
            .into_iter()
            .collect::<HashSet<_>>();
        let started = Instant::now();
        let actual = index.search(&query, 100).unwrap();
        latencies.push(started.elapsed().as_secs_f64() * 1000.0);
        recall += f64::from(
            u32::try_from(
                actual
                    .keys
                    .iter()
                    .filter(|id| expected.contains(id))
                    .count(),
            )
            .unwrap(),
        ) / 100.0;
    }
    let path = root.path().join("bench.usearch");
    index.save(path.to_str().unwrap()).unwrap();
    latencies.sort_by(f64::total_cmp);
    eprintln!("chunks={count} dimensions=640 build_s={:.2} p95_ms={:.2} recall_at_100={:.4} index_bytes={}", build.as_secs_f64(), latencies[18], recall / 20.0, std::fs::metadata(path).unwrap().len());
    assert!(recall / 20.0 >= 0.95);
}

#[test]
#[ignore = "显式测量完整词法、容错与真实 Harrier 查询推理；复用本机模型缓存"]
fn hybrid_query_latency() {
    let cache = std::env::var("NOEMORI_HARRIER_MODELS").expect("模型缓存目录");
    let count =
        std::env::var("NOEMORI_SEARCH_BENCH_NOTES").map_or(10_000, |v| v.parse::<usize>().unwrap());
    let root = TempDir::new().unwrap();
    let index = TempDir::new().unwrap();
    for id in 0..count {
        std::fs::write(root.path().join(format!("{id}.md")), format!("# 数据库研究 {id}\n\nDatabase transactions guarantee consistency and rollback partial writes.\n")).unwrap();
    }
    let vault = Vault::open(root.path(), index.path()).unwrap();
    vault.configure_search_model(Path::new(&cache)).unwrap();
    let token = SearchCancellation::default();
    let mut harrier =
        Harrier::open(&PathBuf::from(cache).join(model::MODEL_DIRECTORY), &token).unwrap();
    let reference = harrier
        .encode(
            "Database transactions guarantee consistency and rollback partial writes.",
            false,
            &token,
        )
        .unwrap();
    // 固定块内容复用真实向量，避免把批量建库推理混入查询延迟指标。
    let conn = vault.lock_conn().unwrap();
    conn.execute(
        "INSERT INTO semantic_embeddings(model, input_hash, vector) VALUES (?, 'benchmark', ?)",
        params![VERSION, encode(&reference)],
    )
    .unwrap();
    let embedding = conn.last_insert_rowid();
    conn.execute("INSERT INTO semantic_chunks(path, content_hash, embedding_id, start_byte, end_byte) SELECT path, content_hash, ?, 0, 3 FROM files", [embedding]).unwrap();
    conn.execute(
        "INSERT INTO semantic_documents SELECT path, content_hash, ? FROM files",
        [VERSION],
    )
    .unwrap();
    drop(conn);
    vault.publish_semantic_index(&token).unwrap();
    let query = crate::HybridQuery {
        text: "如何撤销部分写入".into(),
        filter: crate::SearchExpr::And(vec![]),
        limit: 100,
    };
    let mut samples = Vec::new();
    for _ in 0..21 {
        let started = Instant::now();
        let page = vault.search_hybrid(&query, None, &token).unwrap();
        assert!(!page.hits.is_empty());
        assert_eq!(page.semantic.state, SemanticState::Ready);
        samples.push(started.elapsed().as_secs_f64() * 1000.0);
    }
    let cold = samples.remove(0);
    samples.sort_by(f64::total_cmp);
    eprintln!(
        "notes={count} cold_ms={cold:.2} hybrid_p50_ms={:.2} hybrid_p95_ms={:.2}",
        samples[9], samples[18]
    );
    assert!(samples[18] <= 500.0, "融合热查询超出 500ms 预算");
}
