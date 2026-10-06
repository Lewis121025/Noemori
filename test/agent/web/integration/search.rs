use super::*;
use std::time::Duration;

#[tokio::test]
async fn a_stalled_source_cannot_discard_the_other_sources_results() {
    let success = std::future::ready(Ok(SearchBatch {
        results: vec![SearchResult {
            title: "文档".into(),
            summary: "摘要".into(),
            url: "https://example.com/doc".into(),
        }],
        warnings: Vec::new(),
    }));
    let stalled = std::future::pending::<Result<SearchBatch, String>>();
    let result = tokio::time::timeout(
        Duration::from_millis(100),
        collect_results(success, stalled, Duration::from_millis(10), 10),
    )
    .await;
    assert!(
        result.is_ok(),
        "慢源没有在独立预算内结束，已成功的结果被拖住"
    );
    let super::super::WebOutput::Search { results, warnings } = result.unwrap().unwrap() else {
        panic!("缺少搜索结果")
    };
    assert_eq!(results.len(), 1);
    assert_eq!(warnings.len(), 1);
    assert!(warnings[0].reason.contains("超时"));
}

#[tokio::test]
async fn successful_source_warnings_survive_merging_with_other_results() {
    let source = SearchBatch {
        results: vec![SearchResult {
            title: "文档".into(),
            summary: "摘要".into(),
            url: "https://example.com/doc".into(),
        }],
        warnings: vec!["页面仍在更新".into()],
    };
    let other = SearchBatch {
        results: Vec::new(),
        warnings: Vec::new(),
    };
    let result = collect_results(
        std::future::ready(Ok(source)),
        std::future::ready(Ok(other)),
        Duration::from_secs(1),
        10,
    )
    .await
    .unwrap();
    let super::super::WebOutput::Search { results, warnings } = result else {
        panic!("缺少搜索结果")
    };
    assert_eq!(results.len(), 1);
    assert_eq!(warnings.len(), 1);
    assert!(matches!(warnings[0].source, SearchEngine::Bing));
    assert_eq!(warnings[0].reason, "页面仍在更新");
}
