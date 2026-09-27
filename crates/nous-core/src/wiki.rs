//! wiki 目标的转义与实体规则；索引和改名必须使用同一套文本语义。

use std::fmt::Write;
use std::ops::Range;
use std::sync::OnceLock;

use markdown::{to_mdast, ParseOptions};
use regex::Regex;

fn text_tokens() -> &'static Regex {
    static TOKENS: OnceLock<Regex> = OnceLock::new();
    TOKENS.get_or_init(|| {
        Regex::new(
            r"\\[[:punct:]]|&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});",
        )
        .expect("Markdown 转义与实体正则")
    })
}

/// 只解码 Markdown 转义及字符实体，不把目标中的星号等当作格式语法。
pub(crate) fn decode_text(source: &str) -> String {
    text_tokens()
        .replace_all(source, |captures: &regex::Captures<'_>| {
            let encoded = &captures[0];
            to_mdast(encoded, &ParseOptions::default())
                .map_or_else(|_| encoded.to_string(), |node| node.to_string())
        })
        .into_owned()
}

/// 返回会被 Markdown 解码的源区间；提及扫描不得把实体名的一部分当成可直接改写的正文。
pub(crate) fn decoded_ranges(source: &str) -> Vec<Range<usize>> {
    text_tokens()
        .find_iter(source)
        .filter(|found| decode_text(found.as_str()) != found.as_str())
        .map(|found| found.range())
        .collect()
}

/// 写回已解码的目标，保护实体、转义和 wiki 结束分隔符。
pub(crate) fn encode_text(value: &str) -> String {
    let mut out = String::new();
    for character in value.chars() {
        if matches!(character, '\\' | '&' | '[' | ']') {
            write!(out, "&#{};", u32::from(character)).expect("写入字符串不会失败");
        } else {
            out.push(character);
        }
    }
    out
}
