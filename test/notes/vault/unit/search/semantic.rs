//! 向量的版本过滤、图恢复与数值契约；不依赖下载模型。

#[path = "../../support/search.rs"]
mod corpus;

use super::*;
use std::fs;
use tempfile::TempDir;

fn fixture() -> (TempDir, TempDir, Vault) {
    let root = TempDir::new().unwrap();
    let index = TempDir::new().unwrap();
    fs::write(root.path().join("one.md"), "# One\n\nfirst text\n").unwrap();
    fs::write(root.path().join("two.md"), "# Two\n\nsecond text\n").unwrap();
    let vault = Vault::open(root.path(), index.path()).unwrap();
    (root, index, vault)
}

fn insert(vault: &Vault, path: &str, axis: usize) {
    let conn = vault.lock_conn().unwrap();
    let mut vector = vec![0.0_f32; model::DIMENSIONS];
    vector[axis] = 1.0;
    if axis == 1 {
        vector[0] = 0.6;
        vector[1] = 0.8;
    }
    conn.execute(
        "INSERT OR IGNORE INTO semantic_embeddings(model, input_hash, vector) VALUES (?, ?, ?)",
        params![VERSION, format!("axis-{axis}"), encode(&vector)],
    )
    .unwrap();
    conn.execute("INSERT INTO semantic_chunks(path, content_hash, embedding_id, start_byte, end_byte) SELECT f.path, f.content_hash, e.id, 0, 3 FROM files f, semantic_embeddings e WHERE f.path = ? AND e.model = ? AND e.input_hash = ?", params![path, VERSION, format!("axis-{axis}")]).unwrap();
    conn.execute("INSERT OR REPLACE INTO semantic_documents(path, content_hash, model) SELECT path, content_hash, ? FROM files WHERE path = ?", params![VERSION, path]).unwrap();
}

#[test]
fn changed_derived_text_invalidates_old_vectors_even_when_file_hash_is_unchanged() {
    let (_root, index, vault) = fixture();
    insert(&vault, "one.md", 0);
    let conn = vault.lock_conn().unwrap();
    let source: i64 = conn
        .query_row(
            "SELECT rowid FROM search_sources WHERE path = 'one.md'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    conn.execute(
        "UPDATE search_sources SET body = 'new parser output' WHERE path = 'one.md'",
        [],
    )
    .unwrap();
    assert_eq!(
        Semantic::new(index.path()).status(&conn).unwrap().indexed,
        0
    );
    let mut query = vec![0.0; model::DIMENSIONS];
    query[0] = 1.0;
    let results = graph::Graph::default()
        .search(
            &conn,
            index.path(),
            &query,
            &HashSet::from([u64::try_from(source).unwrap()]),
            &SearchCancellation::default(),
        )
        .unwrap();
    assert!(results.hits.is_empty());
}

#[test]
fn old_inference_cannot_publish_after_derived_input_changes() {
    let (_root, _index, vault) = fixture();
    let mut conn = vault.lock_conn().unwrap();
    let input = source::next(&conn).unwrap().unwrap();
    conn.execute(
        "UPDATE search_sources SET body = 'new parser output' WHERE path = ?",
        [&input.path],
    )
    .unwrap();
    let prepared = || {
        vec![source::EncodedChunk {
            range: 0..3,
            input_hash: "prepared".into(),
            vector: encode(&model::normalize(&vec![1.0; model::DIMENSIONS]).unwrap()),
        }]
    };
    assert!(!source::publish(&mut conn, &input, prepared()).unwrap());
    let current = source::next(&conn).unwrap().unwrap();
    assert!(source::publish(&mut conn, &current, prepared()).unwrap());
}

#[test]
fn partial_semantic_schema_rebuild_invalidates_completion_and_old_graph_identity() {
    let (root, index, vault) = fixture();
    insert(&vault, "one.md", 0);
    let token = SearchCancellation::default();
    graph::Graph::default()
        .synchronize(&vault.lock_conn().unwrap(), index.path(), &token)
        .unwrap();
    vault
        .lock_conn()
        .unwrap()
        .execute_batch("DROP TABLE semantic_chunks;")
        .unwrap();
    drop(vault);
    let reopened = Vault::open(root.path(), index.path()).unwrap();
    assert_eq!(reopened.semantic_status().unwrap().indexed, 0);
    insert(&reopened, "one.md", 2);
    let conn = reopened.lock_conn().unwrap();
    let source: i64 = conn
        .query_row(
            "SELECT rowid FROM search_sources WHERE path = 'one.md'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let mut query = vec![0.0; model::DIMENSIONS];
    query[0] = 1.0;
    let results = graph::Graph::default()
        .search(
            &conn,
            index.path(),
            &query,
            &HashSet::from([u64::try_from(source).unwrap()]),
            &token,
        )
        .unwrap();
    assert!(
        results.hits.is_empty(),
        "复用的向量行号不能使重建前的图重新生效"
    );
}

#[test]
fn validates_dimensions_finite_values_and_normalization() {
    assert!(decode(&[0; 4]).is_err());
    assert!(model::normalize(&vec![0.0; model::DIMENSIONS]).is_err());
    assert!(model::normalize(&vec![f32::NAN; model::DIMENSIONS]).is_err());
    let normalized = model::normalize(&vec![2.0; model::DIMENSIONS]).unwrap();
    assert!((normalized.iter().map(|v| v * v).sum::<f32>() - 1.0).abs() < 0.0001);
}

fn cancellation_while_locked<T>(
    mutex: &Mutex<T>,
    operation: impl FnOnce(SearchCancellation) -> Result<(), Error> + Send,
) {
    let guard = mutex.lock().unwrap();
    let token = SearchCancellation::default();
    let worker_token = token.clone();
    let (completed, result) = std::sync::mpsc::channel();
    let (entered, started) = std::sync::mpsc::sync_channel(0);
    std::thread::scope(|scope| {
        let worker = scope.spawn(move || {
            entered.send(()).unwrap();
            completed.send(operation(worker_token)).unwrap();
        });
        started.recv().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        token.cancel();
        let cancelled = result.recv_timeout(std::time::Duration::from_millis(500));
        // 即使断言失败也先释放锁，让失败用例能正常结束并清理临时目录。
        drop(guard);
        worker.join().unwrap();
        assert!(matches!(cancelled, Ok(Err(Error::SearchCancelled))));
    });
}

#[test]
fn cancellation_interrupts_waiting_for_indexing_lock() {
    let index = TempDir::new().unwrap();
    let semantic = Semantic::new(index.path());
    cancellation_while_locked(&semantic.indexing, |token| semantic.install(None, &token));
}

#[test]
fn cancellation_interrupts_waiting_for_model_lock() {
    let index = TempDir::new().unwrap();
    let semantic = Semantic::new(index.path());
    cancellation_while_locked(&semantic.model, |token| {
        semantic.with_model(&token, |_| Ok(()))
    });
}

#[test]
fn cancellation_interrupts_waiting_for_graph_lock() {
    let index = TempDir::new().unwrap();
    let semantic = Semantic::new(index.path());
    cancellation_while_locked(&semantic.graph, |token| {
        let conn = Connection::open_in_memory().unwrap();
        semantic
            .retrieve(&conn, index.path(), &[], &HashSet::new(), &token)
            .map(|_| ())
    });
}

#[cfg(unix)]
#[test]
fn model_verification_preserves_permission_errors_instead_of_starting_repair() {
    use std::os::unix::fs::PermissionsExt;
    let directory = TempDir::new().unwrap();
    let root = directory.path().join("model");
    let source = directory.path().join("source");
    fs::create_dir_all(root.join("onnx")).unwrap();
    fs::create_dir(&source).unwrap();
    fs::write(root.join("ready"), "ready").unwrap();
    let blocked = root.join("onnx/model.onnx");
    fs::write(&blocked, "inaccessible").unwrap();
    fs::set_permissions(&blocked, fs::Permissions::from_mode(0o0)).unwrap();
    // 特权账户绕过 Unix 读权限，无法在该环境验证权限拒绝。
    if fs::File::open(&blocked).is_ok() {
        return;
    }
    let result = model::install(&root, Some(&source), &SearchCancellation::default());
    assert!(
        matches!(result, Err(Error::Io(error)) if error.kind() == std::io::ErrorKind::PermissionDenied)
    );
}

#[test]
fn filters_before_top_k_and_never_returns_stale_vectors() {
    let (root, index, vault) = fixture();
    insert(&vault, "one.md", 0);
    insert(&vault, "two.md", 1);
    let mut graph = graph::Graph::default();
    let mut query = vec![0.0; model::DIMENSIONS];
    query[0] = 1.0;
    let token = SearchCancellation::default();
    let source: i64 = vault
        .lock_conn()
        .unwrap()
        .query_row(
            "SELECT rowid FROM search_sources WHERE path='two.md'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let allowed = HashSet::from([u64::try_from(source).unwrap()]);
    let results = graph
        .search(
            &vault.lock_conn().unwrap(),
            index.path(),
            &query,
            &allowed,
            &token,
        )
        .unwrap();
    assert_eq!(results.hits.len(), 1);
    assert_eq!(results.hits[0].source, u64::try_from(source).unwrap());
    fs::write(root.path().join("two.md"), "# Replaced\n\nnew content\n").unwrap();
    vault.refresh_index().unwrap();
    assert!(graph
        .search(
            &vault.lock_conn().unwrap(),
            index.path(),
            &query,
            &allowed,
            &token
        )
        .unwrap()
        .hits
        .is_empty());
}

#[test]
fn persists_reopens_and_recovers_corrupted_graph_without_reembedding() {
    let (_root, index, vault) = fixture();
    insert(&vault, "one.md", 0);
    let token = SearchCancellation::default();
    graph::Graph::default()
        .synchronize(&vault.lock_conn().unwrap(), index.path(), &token)
        .unwrap();
    assert!(index.path().join("semantic.usearch").is_file());
    graph::Graph::default()
        .synchronize(&vault.lock_conn().unwrap(), index.path(), &token)
        .unwrap();
    fs::write(index.path().join("semantic.usearch"), b"broken graph").unwrap();
    graph::Graph::default()
        .synchronize(&vault.lock_conn().unwrap(), index.path(), &token)
        .unwrap();
    assert!(
        fs::metadata(index.path().join("semantic.usearch"))
            .unwrap()
            .len()
            > 12
    );
}

#[test]
fn cancelled_graph_build_does_not_publish_a_checkpoint() {
    let (_root, index, vault) = fixture();
    insert(&vault, "one.md", 0);
    let token = SearchCancellation::default();
    token.cancel();
    assert!(matches!(
        graph::Graph::default().synchronize(&vault.lock_conn().unwrap(), index.path(), &token),
        Err(Error::SearchCancelled)
    ));
    assert!(!index.path().join("semantic.checkpoint").exists());
}

#[test]
fn failed_checkpoint_is_retried_and_valid_checkpoint_is_not_rewritten() {
    let (_root, index, vault) = fixture();
    insert(&vault, "one.md", 0);
    let path = index.path().join("semantic.usearch");
    fs::create_dir(&path).unwrap();
    let token = SearchCancellation::default();
    let mut graph = graph::Graph::default();
    assert!(graph
        .synchronize(&vault.lock_conn().unwrap(), index.path(), &token)
        .is_err());
    fs::remove_dir(&path).unwrap();
    graph
        .synchronize(&vault.lock_conn().unwrap(), index.path(), &token)
        .unwrap();
    assert!(path.is_file());
    let modified = fs::metadata(&path).unwrap().modified().unwrap();
    graph::Graph::default()
        .synchronize(&vault.lock_conn().unwrap(), index.path(), &token)
        .unwrap();
    assert_eq!(fs::metadata(path).unwrap().modified().unwrap(), modified);
}

#[test]
fn identical_inputs_share_one_vector_and_keep_surviving_locations() {
    let (root, index, vault) = fixture();
    insert(&vault, "one.md", 0);
    insert(&vault, "two.md", 0);
    let count: i64 = vault
        .lock_conn()
        .unwrap()
        .query_row("SELECT count(*) FROM semantic_embeddings", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 1);
    let sources = || {
        let conn = vault.lock_conn().unwrap();
        let sources = conn
            .prepare("SELECT rowid FROM search_sources")
            .unwrap()
            .query_map([], |r| r.get::<_, i64>(0))
            .unwrap()
            .map(|row| u64::try_from(row.unwrap()).unwrap())
            .collect::<HashSet<_>>();
        sources
    };
    let mut graph = graph::Graph::default();
    let mut query = vec![0.0; model::DIMENSIONS];
    query[0] = 1.0;
    let token = SearchCancellation::default();
    let allowed = sources();
    assert_eq!(
        graph
            .search(
                &vault.lock_conn().unwrap(),
                index.path(),
                &query,
                &allowed,
                &token
            )
            .unwrap()
            .hits
            .len(),
        2
    );
    fs::remove_file(root.path().join("one.md")).unwrap();
    vault.refresh_index().unwrap();
    let allowed = sources();
    let remaining = graph
        .search(
            &vault.lock_conn().unwrap(),
            index.path(),
            &query,
            &allowed,
            &token,
        )
        .unwrap();
    assert_eq!(remaining.hits.len(), 1);
    assert!(allowed.contains(&remaining.hits[0].source));
}

#[test]
#[ignore = "使用已安装的 Harrier 模型验证公开参考分数与相关／无关文本"]
fn harrier_reference_scores_and_relevance() {
    let cache = std::env::var("NOEMORI_HARRIER_MODELS").expect("模型缓存目录");
    let mut model = Harrier::open(
        &PathBuf::from(cache).join(model::MODEL_DIRECTORY),
        &SearchCancellation::default(),
    )
    .unwrap();
    let token = SearchCancellation::default();
    let body = "主题甲\n第一段。\n主题乙\n第二段。\n";
    let boundary = body.find("主题乙").unwrap();
    let ranges = model.ranges(body, &[0, boundary]).unwrap();
    assert_eq!(ranges.len(), 2);
    assert!(ranges
        .iter()
        .all(|range| range.end <= boundary || range.start >= boundary));
    let short = "一个很长很长的标题\n短句";
    assert_eq!(model.ranges(short, &[]).unwrap(), vec![0..short.len()]);
    let corpus = corpus::Corpus::load();
    let documents = corpus.documents;
    let vectors = documents
        .iter()
        .map(|text| model.encode(text, false, &token).unwrap())
        .collect::<Vec<_>>();
    for case in corpus.queries {
        let query = case.text.as_str();
        let expected = case.expected;
        let vector = model.encode(query, true, &token).unwrap();
        let scores = vectors
            .iter()
            .map(|doc| vector.iter().zip(doc).map(|(a, b)| a * b).sum::<f32>())
            .collect::<Vec<_>>();
        let best = scores
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.total_cmp(b.1))
            .unwrap()
            .0;
        eprintln!("query={query} expected={expected} scores={scores:?}");
        assert_eq!(best, expected);
        assert!(scores[expected] >= 0.30);
        if expected == 0 {
            assert!((scores[0] - 0.6457).abs() < 0.02);
        }
        if expected == 1 {
            assert!((scores[1] - 0.6741).abs() < 0.02);
        }
    }
}
