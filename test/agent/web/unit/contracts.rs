use noemori_agent::tool::web::search::{
    SearchEngine, SearchResult, merge_results, parse_search_page,
};

#[test]
fn search_pages_distinguish_results_empty_captcha_and_layout_changes() {
    let bing = r#"<li class="b_algo"><h2><a href="https://example.com/release">发布说明</a></h2><div class="b_caption"><p>版本 &amp; 说明</p></div></li>"#;
    let results = parse_search_page(SearchEngine::Bing, bing).unwrap();
    assert_eq!(results[0].title, "发布说明");
    assert_eq!(results[0].summary, "版本 & 说明");
    let ddg = r#"<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdoc">文档</a><div class="result__snippet">摘要</div></div>"#;
    assert_eq!(
        parse_search_page(SearchEngine::Duckduckgo, ddg).unwrap()[0].url,
        "https://example.com/doc"
    );
    assert!(
        parse_search_page(SearchEngine::Bing, "<div class='b_no'>无结果</div>")
            .unwrap()
            .is_empty()
    );
    assert!(
        parse_search_page(
            SearchEngine::Duckduckgo,
            "<form id='challenge-form'></form>"
        )
        .unwrap_err()
        .contains("验证码")
    );
    assert!(
        parse_search_page(SearchEngine::Bing, "<main>新版界面</main>")
            .unwrap_err()
            .contains("结构")
    );
    assert!(
        parse_search_page(
            SearchEngine::Bing,
            "<li class='b_algo'><h2><a href='javascript:alert(1)'>错误</a></h2></li>"
        )
        .is_err()
    );
}

#[test]
fn merging_is_stable_deduplicates_pages_and_rejects_invalid_urls() {
    let item = |url: &str, summary: &str| SearchResult {
        title: "文档".into(),
        summary: summary.into(),
        url: url.into(),
    };
    let first = vec![
        item("https://example.com/a#one", "短"),
        item("https://example.com/b", ""),
    ];
    let second = vec![item("https://example.com/a#two", "更完整的摘要")];
    let result = merge_results(vec![first, second], 10).unwrap();
    assert_eq!(result.len(), 2);
    assert_eq!(result[0].url, "https://example.com/a#one");
    assert_eq!(result[0].summary, "更完整的摘要");
    assert!(merge_results(vec![vec![item("invalid", "")]], 10).is_err());
}
