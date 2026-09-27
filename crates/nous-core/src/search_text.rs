//! 检索正文与源码的对应关系；区间统一使用 UTF-8 字节，实体和转义保留原始范围。

use std::ops::Range;

use serde::{Deserialize, Serialize};

/// 连续的正文区间及源码区间；等长区间线性映射，实体等变长片段映射到完整源码。
#[derive(Default, Serialize, Deserialize)]
pub(crate) struct SourceMap {
    /// `(正文起点, 正文终点, 源码起点, 源码终点)`；数组编码控制派生索引体积。
    spans: Vec<(usize, usize, usize, usize)>,
    /// 真实标题在检索正文中的起点，不能通过标题同名文本反推章节边界。
    pub sections: Vec<usize>,
    /// 源码每行的起点；用于命中行号，不重复扫描整篇原文。
    lines: Vec<usize>,
}

/// 原始片段的解码方式；代码里的实体与反斜杠必须保持字面。
#[derive(Clone, Copy)]
pub(crate) enum TextKind {
    Text,
    InlineCode,
    Code,
}

impl SourceMap {
    /// 记录原始文件的行边界；BOM 和 CRLF 都保持原始字节下标。
    pub fn new(source: &str) -> Self {
        let mut lines = vec![0];
        for (index, byte) in source.bytes().enumerate() {
            if byte == b'\n' || (byte == b'\r' && source.as_bytes().get(index + 1) != Some(&b'\n'))
            {
                lines.push(index + 1);
            }
        }
        Self {
            lines,
            ..Self::default()
        }
    }

    /// 追加解析器已确认的文字；只有逐字验证过的片段才建立映射。
    pub fn append(
        &mut self,
        body: &mut String,
        value: &str,
        source: &str,
        mut range: Range<usize>,
        kind: TextKind,
    ) {
        let base = body.len();
        body.push_str(value);
        if value.is_empty() {
            return;
        }
        let Some(mut raw) = source.get(range.clone()) else {
            return;
        };
        if matches!(kind, TextKind::Code) && (raw.starts_with("```") || raw.starts_with("~~~")) {
            let skip = raw.find('\n').map_or(raw.len(), |at| at + 1);
            range.start += skip;
            raw = &raw[skip..];
        } else if matches!(kind, TextKind::InlineCode) {
            let skip = raw.bytes().take_while(|byte| *byte == b'`').count();
            range.start += skip;
            raw = &raw[skip..raw.len().saturating_sub(skip)];
        }
        // 普通文本无需逐字符建表；代码同样先验证连续原文，避免把语言名当作正文。
        if let Some(at) = raw
            .find(value)
            .filter(|_| !matches!(kind, TextKind::Text) || raw == value)
        {
            self.push(
                base,
                base + value.len(),
                range.start + at,
                range.start + at + value.len(),
            );
            return;
        }
        let checkpoint = self.spans.len();
        let previous = self.spans.last().copied();
        let mut input = 0;
        let mut output = 0;
        let mut line_start = true;
        while input < raw.len() && output < value.len() {
            let (length, decoded) = decode(&raw[input..], kind);
            if value[output..].starts_with(&decoded) {
                self.push(
                    base + output,
                    base + output + decoded.len(),
                    range.start + input,
                    range.start + input + length,
                );
                input += length;
                output += decoded.len();
                line_start = decoded.ends_with('\n');
            } else if (line_start && matches!(raw.as_bytes()[input], b' ' | b'\t' | b'>'))
                || (matches!(kind, TextKind::InlineCode) && output == 0 && decoded == " ")
            {
                input += length;
            } else {
                // 未被解析值证实的转换不猜位置；保留正文可搜索性，但不给出错误定位。
                self.spans.truncate(checkpoint);
                if let (Some(last), Some(previous)) = (self.spans.last_mut(), previous) {
                    *last = previous;
                }
                return;
            }
        }
        if output != value.len() {
            self.spans.truncate(checkpoint);
            if let (Some(last), Some(previous)) = (self.spans.last_mut(), previous) {
                *last = previous;
            }
        }
    }

    fn push(&mut self, start: usize, end: usize, from: usize, to: usize) {
        if let Some(last) = self.spans.last_mut() {
            if last.1 == start
                && last.3 == from
                && last.1 - last.0 == last.3 - last.2
                && end - start == to - from
            {
                last.1 = end;
                last.3 = to;
                return;
            }
        }
        self.spans.push((start, end, from, to));
    }

    /// 将正文非空命中映射到源码与一基行号；没有可信映射时返回 `None`。
    pub fn locate(&self, range: Range<usize>) -> Option<(usize, usize, usize)> {
        let first = self
            .spans
            .get(self.spans.partition_point(|span| span.1 <= range.start))?;
        let last = self
            .spans
            .get(self.spans.partition_point(|span| span.1 < range.end))?;
        if range.start < first.0 || range.end > last.1 {
            return None;
        }
        let start = first.2
            + if first.1 - first.0 == first.3 - first.2 {
                range.start - first.0
            } else {
                0
            };
        let end = last.2
            + if last.1 - last.0 == last.3 - last.2 {
                range.end - last.0
            } else {
                last.3 - last.2
            };
        Some((
            start,
            end,
            self.lines.partition_point(|line| *line <= start),
        ))
    }
}

fn decode(raw: &str, kind: TextKind) -> (usize, String) {
    let ch = raw.chars().next().expect("调用方保证非空");
    if ch == '\r' || ch == '\n' {
        return (
            if raw.starts_with("\r\n") { 2 } else { 1 },
            if matches!(kind, TextKind::InlineCode) {
                " "
            } else {
                "\n"
            }
            .into(),
        );
    }
    if matches!(kind, TextKind::Text) {
        if ch == '\\' {
            if let Some(next) = raw.chars().nth(1).filter(char::is_ascii_punctuation) {
                return (2, next.to_string());
            }
        }
        if ch == '&' {
            if let Some(end) = raw.find(';').filter(|end| *end <= 32) {
                let name = &raw[1..end];
                let decoded = if let Some(digits) =
                    name.strip_prefix("#x").or_else(|| name.strip_prefix("#X"))
                {
                    u32::from_str_radix(digits, 16)
                        .ok()
                        .map(|_| markdown::decode_numeric(digits, 16))
                } else if let Some(digits) = name.strip_prefix('#') {
                    digits
                        .parse::<u32>()
                        .ok()
                        .map(|_| markdown::decode_numeric(digits, 10))
                } else {
                    markdown::decode_named(name, true)
                };
                if let Some(decoded) = decoded {
                    return (end + 1, decoded);
                }
            }
        }
    }
    (ch.len_utf8(), ch.to_string())
}

/// 索引与查询共享逐字符 Unicode 小写规则，避免 `SQLite` 内建 ASCII 规则造成漏搜。
pub(crate) fn fold(text: &str) -> String {
    text.chars().flat_map(char::to_lowercase).collect()
}

/// 将一个或两个规范化字符编码为 ASCII 词项；长度标记避免单字与双字碰撞。
pub(crate) fn short_token(text: &str) -> String {
    let mut chars = text.chars();
    let first = u64::from(chars.next().expect("调用方保证短词非空"));
    let key = chars.next().map_or(first, |second| {
        (1 << 42) | (first << 21) | u64::from(second)
    });
    format!("g{key:x}")
}

/// 每篇仅记录不同的单字与双字词项；无需保存词频、位置或重复正文。
pub(crate) fn short_terms(title: &str, body: &str) -> String {
    let mut keys = std::collections::HashSet::new();
    for text in [title, body] {
        let mut previous: Option<u64> = None;
        for ch in text.chars().flat_map(char::to_lowercase) {
            let current = u64::from(ch);
            keys.insert(current);
            if let Some(first) = previous {
                keys.insert((1 << 42) | (first << 21) | current);
            }
            previous = Some(current);
        }
    }
    let mut keys = keys.into_iter().collect::<Vec<_>>();
    keys.sort_unstable();
    keys.into_iter()
        .map(|key| format!("g{key:x}"))
        .collect::<Vec<_>>()
        .join(" ")
}
