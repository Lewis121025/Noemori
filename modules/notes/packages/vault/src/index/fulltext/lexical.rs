//! 融合召回使用完整拉丁词与中文双字词项；严格子串索引保持独立。

use crate::{markdown::source_map::fold, Error, SearchCancellation};
use levenshtein_automata::{Distance, LevenshteinAutomatonBuilder, DFA};
use rusqlite::Connection;
use std::{collections::BTreeSet, io, sync::OnceLock};
use tantivy::{
    query::{BooleanQuery, BoostQuery, Occur, Query, TermQuery},
    schema::{Field, IndexRecordOption, SchemaBuilder, TextFieldIndexing, TextOptions, STRING},
    Searcher, TantivyDocument, Term,
};
use tantivy_fst::Automaton;

/// 四个字段共享查询词项，权重只表达笔记身份和正文的区别。
#[derive(Clone, Copy)]
pub(super) struct Fields(pub [Field; 4], pub Field);

impl Fields {
    /// 向 schema 注册计频字段和完整身份字段，返回建库与查询共用的字段句柄。
    pub fn build(schema: &mut SchemaBuilder) -> Self {
        let options = TextOptions::default().set_indexing_options(
            TextFieldIndexing::default()
                .set_tokenizer("whitespace")
                .set_index_option(IndexRecordOption::WithFreqs),
        );
        Self(
            ["lex_title", "lex_alias", "lex_heading", "lex_body"]
                .map(|name| schema.add_text_field(name, options.clone())),
            schema.add_text_field("lex_identity", STRING),
        )
    }

    /// 将 path 的标题、别名、章节和 body 加入 doc；conn 须与正文同版，SQL 错误传播。
    pub fn add(
        &self,
        doc: &mut TantivyDocument,
        conn: &Connection,
        path: &str,
        title: &str,
        body: &str,
    ) -> Result<(), Error> {
        let mut aliases = conn.prepare(
            "SELECT key, value FROM attributes WHERE path = ? AND key IN ('alias', 'aliases')",
        )?;
        let attrs = aliases
            .query_map([path], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<Vec<(String, String)>, _>>()?;
        let alias_keys = crate::links::identity::alias_keys(&attrs);
        doc.add_text(self.1, fold(title));
        for alias in &alias_keys {
            doc.add_text(self.1, fold(alias));
        }
        let aliases = alias_keys.join(" ");
        let mut headings = conn.prepare("SELECT text FROM headings WHERE path = ? ORDER BY idx")?;
        let headings = headings
            .query_map([path], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?
            .join(" ");
        for (field, value) in self.0.into_iter().zip([title, &aliases, &headings, body]) {
            doc.add_text(field, terms(value).join(" "));
        }
        Ok(())
    }

    /// 将已规范化的 words 组成带身份权重的并集查询，返回可与硬筛选组合的查询树。
    pub fn query(&self, words: &[String]) -> Box<dyn Query> {
        Box::new(BooleanQuery::union(
            self.0
                .into_iter()
                .zip([5.0, 5.0, 2.0, 1.0])
                .map(|(field, boost)| {
                    let query = BooleanQuery::union(
                        words
                            .iter()
                            .map(|word| {
                                Box::new(TermQuery::new(
                                    Term::from_field_text(field, word),
                                    IndexRecordOption::WithFreqs,
                                )) as Box<dyn Query>
                            })
                            .collect(),
                    );
                    Box::new(BoostQuery::new(Box::new(query), boost)) as Box<dyn Query>
                })
                .collect(),
        ))
    }

    /// 自动机与词典求交后再执行倒排查询；词项上限约束容错成本，原词不重复投票。
    /// words 须已规范化；返回 searcher 中的替代词，索引、词项解码和取消错误传播。
    pub fn expand(
        &self,
        searcher: &Searcher,
        words: &[String],
        token: &SearchCancellation,
    ) -> Result<Vec<String>, Error> {
        static BUILDER: OnceLock<LevenshteinAutomatonBuilder> = OnceLock::new();
        let builder = BUILDER.get_or_init(|| LevenshteinAutomatonBuilder::new(1, true));
        let mut expanded = BTreeSet::new();
        for word in words
            .iter()
            .filter(|w| w.len() >= 4 && w.len() <= 64 && w.bytes().all(|c| c.is_ascii_alphabetic()))
            .take(16)
        {
            let automaton = EditAutomaton(builder.build_dfa(word));
            let mut found = BTreeSet::new();
            for segment in searcher.segment_readers() {
                for field in self.0 {
                    token.check()?;
                    let inverted = segment.inverted_index(field).map_err(io::Error::other)?;
                    let mut stream = inverted.terms().search(&automaton).into_stream()?;
                    while stream.advance() {
                        token.check()?;
                        let term = std::str::from_utf8(stream.key()).map_err(io::Error::other)?;
                        if term != word {
                            found.insert(term.to_owned());
                        }
                        if found.len() >= 32 {
                            break;
                        }
                    }
                    if found.len() >= 32 {
                        break;
                    }
                }
                if found.len() >= 32 {
                    break;
                }
            }
            expanded.extend(found);
        }
        Ok(expanded.into_iter().collect())
    }
}

struct EditAutomaton(DFA);
impl Automaton for EditAutomaton {
    type State = u32;
    fn start(&self) -> u32 {
        self.0.initial_state()
    }
    fn is_match(&self, state: &u32) -> bool {
        matches!(self.0.distance(*state), Distance::Exact(_))
    }
    fn can_match(&self, state: &u32) -> bool {
        *state != levenshtein_automata::SINK_STATE
    }
    fn accept(&self, state: &u32, byte: u8) -> u32 {
        self.0.transition(*state, byte)
    }
}

/// 中文连续区间产生单字及双字词项；英文和数字保持完整词，保留重复项供 BM25 计频。
pub(crate) fn terms(text: &str) -> Vec<String> {
    let normalized = fold(text);
    let mut words = Vec::new();
    let mut word = String::new();
    let mut previous = None;
    for c in normalized.chars().chain(std::iter::once(' ')) {
        if is_cjk(c) {
            if !word.is_empty() {
                words.push(std::mem::take(&mut word));
            }
            words.push(c.to_string());
            if let Some(p) = previous {
                words.push(format!("{p}{c}"));
            }
            previous = Some(c);
        } else {
            previous = None;
            if c.is_alphanumeric() || c == '_' {
                word.push(c);
            } else if !word.is_empty() {
                words.push(std::mem::take(&mut word));
            }
        }
    }
    words
}

/// 多字中文查询使用双字片段，单字仅在独立查询时参与召回，避免常见单字淹没排名。
pub(crate) fn query_terms(text: &str) -> Vec<String> {
    let all = terms(text);
    all.iter()
        .filter(|word| {
            if is_query_stop_word(word) {
                return false;
            }
            let mut chars = word.chars();
            let first = chars.next();
            let single_cjk = first.is_some_and(is_cjk) && chars.next().is_none();
            !single_cjk
                || !all
                    .iter()
                    .any(|other| other.chars().count() == 2 && other.contains(word.as_str()))
        })
        .cloned()
        .collect()
}

fn is_cjk(c: char) -> bool {
    matches!(u32::from(c), 0x3400..=0x9fff | 0x20000..=0x3134f)
}

/// 文件硬筛选与召回处于同一布尔查询，不能先截断结果再筛选。
pub(super) fn filtered(query: Box<dyn Query>, filter: Option<Box<dyn Query>>) -> Box<dyn Query> {
    match filter {
        Some(filter) => Box::new(BooleanQuery::new(vec![
            (Occur::Must, query),
            (Occur::Must, filter),
        ])),
        None => query,
    }
}

/// 返回原文中的完整词项范围；规范化只用于比较，不拿规范化后的字节位置定位。
/// words 是候选词项，未命中返回 None；token 撤销时返回取消错误。
pub(crate) fn word_span(
    text: &str,
    words: &[String],
    token: &SearchCancellation,
) -> Result<Option<std::ops::Range<usize>>, Error> {
    let words = words
        .iter()
        .map(String::as_str)
        .collect::<std::collections::HashSet<_>>();
    let mut start = None;
    for (offset, ch) in text
        .char_indices()
        .chain(std::iter::once((text.len(), ' ')))
    {
        if offset.is_multiple_of(1024) {
            token.check()?;
        }
        if (ch.is_alphanumeric() || ch == '_') && !is_cjk(ch) {
            start.get_or_insert(offset);
        } else if let Some(from) = start.take() {
            if words.contains(fold(&text[from..offset]).as_str()) {
                return Ok(Some(from..offset));
            }
        }
    }
    Ok(None)
}

/// 自然语言软召回排除英文功能词；保留原文给向量模型，严格查询不使用此规则。
pub(crate) fn is_query_stop_word(word: &str) -> bool {
    matches!(
        word,
        "a" | "about"
            | "an"
            | "and"
            | "are"
            | "as"
            | "at"
            | "be"
            | "been"
            | "being"
            | "but"
            | "by"
            | "can"
            | "could"
            | "did"
            | "do"
            | "does"
            | "for"
            | "from"
            | "had"
            | "has"
            | "have"
            | "he"
            | "her"
            | "him"
            | "his"
            | "how"
            | "i"
            | "if"
            | "in"
            | "into"
            | "is"
            | "it"
            | "its"
            | "may"
            | "me"
            | "might"
            | "my"
            | "no"
            | "not"
            | "of"
            | "on"
            | "or"
            | "our"
            | "she"
            | "should"
            | "so"
            | "such"
            | "that"
            | "the"
            | "their"
            | "them"
            | "then"
            | "there"
            | "these"
            | "they"
            | "this"
            | "those"
            | "to"
            | "us"
            | "was"
            | "we"
            | "were"
            | "what"
            | "when"
            | "where"
            | "which"
            | "who"
            | "why"
            | "will"
            | "with"
            | "would"
            | "you"
            | "your"
    )
}
