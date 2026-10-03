//! 模型参考分数与完整融合流程共用同一组可审查的中英文相关性样本。

use serde::Deserialize;

/// 单一相关文档的查询标签；序号对应 documents 和 titles。
#[derive(Deserialize)]
pub struct QueryCase {
    /// 用户原始问句。
    pub text: String,
    /// 唯一直接相关文档的序号。
    pub expected: usize,
}

/// 固定语料与标签，避免模型单测和融合测试采用不同的隐含答案。
#[derive(Deserialize)]
pub struct Corpus {
    /// 笔记标题，融合测试按真实 Markdown 索引。
    pub titles: Vec<String>,
    /// 原始段落，前两个样本保留公开参考文本。
    pub documents: Vec<String>,
    /// 相关性标签。
    pub queries: Vec<QueryCase>,
}

impl Corpus {
    /// 加载仓库内固定夹具；结构或标签损坏时直接使测试失败。
    pub fn load() -> Self {
        let corpus: Self =
            serde_json::from_str(include_str!("../fixtures/search/embedding-relevance.json"))
                .unwrap();
        assert_eq!(corpus.titles.len(), corpus.documents.len());
        assert!(corpus
            .queries
            .iter()
            .all(|query| query.expected < corpus.documents.len()));
        corpus
    }
}
