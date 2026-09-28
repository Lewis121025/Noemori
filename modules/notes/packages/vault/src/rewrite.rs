//! 按字节区间改写链接原文。

use markdown::mdast::{Link, Node};
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use std::path::{Component, Path, PathBuf};

use crate::link::{split_resource, LinkKind};
use crate::pathutil::path_to_slashes;
use crate::Error;

const PATH_COMPONENT: &percent_encoding::AsciiSet = &NON_ALPHANUMERIC
    .remove(b'.')
    .remove(b'-')
    .remove(b'_')
    .remove(b'~');

/// 仅替换链接目标，保留标签、标题、尖括号和资源后缀。
///
/// `original` 为完整链接片段，`new_target` 为新目标；无法定位地址时返回错误并停止改名。
pub fn rewrite_span(kind: LinkKind, original: &str, new_target: &str) -> Result<String, Error> {
    match kind {
        LinkKind::Wiki => Ok(rewrite_wiki(original, new_target)),
        LinkKind::Markdown => rewrite_markdown(original, new_target),
    }
}

fn rewrite_wiki(original: &str, new_target: &str) -> String {
    let inner = original
        .strip_prefix("[[")
        .and_then(|s| s.strip_suffix("]]"))
        .unwrap_or(original);
    let (left, alias) = match inner.split_once('|') {
        Some((target, alias)) => (target, Some(alias)),
        None => (inner, None),
    };
    let escapes = left.bytes().rev().take_while(|byte| *byte == b'\\').count();
    let escaped_separator = alias.is_some() && escapes % 2 == 1;
    let separator = if escaped_separator { "\\|" } else { "|" };
    let target = if escaped_separator {
        &left[..left.len() - 1]
    } else {
        left
    };
    let decoded = crate::wiki::decode_text(target);
    let (_, suffix) = split_resource(&decoded);
    let suffix = crate::wiki::encode_text(suffix);
    let new_target = crate::wiki::encode_text(new_target);
    match alias {
        Some(alias) => format!("[[{new_target}{suffix}{separator}{alias}]]"),
        None => format!("[[{new_target}{suffix}]]"),
    }
}

fn rewrite_markdown(original: &str, new_url: &str) -> Result<String, Error> {
    let invalid = || {
        Error::Io(std::io::Error::other(
            "无法定位 Markdown 链接地址，已停止改名",
        ))
    };
    let raw = original.as_bytes();
    let mut start = destination_start(original).ok_or_else(invalid)?;
    while raw.get(start).is_some_and(u8::is_ascii_whitespace) {
        start += 1;
    }
    let angled = raw.get(start) == Some(&b'<');
    if angled {
        start += 1;
    }
    let mut end = start;
    let mut depth = 0;
    while let Some(&byte) = raw.get(end) {
        if byte == b'\\' {
            end += 2;
            continue;
        }
        if angled && byte == b'>' {
            break;
        }
        if !angled {
            if depth == 0 && (byte == b')' || byte.is_ascii_whitespace()) {
                break;
            }
            if byte == b'(' {
                depth += 1;
            }
            if byte == b')' {
                depth -= 1;
            }
        }
        end += 1;
    }
    let destination = original.get(start..end).ok_or_else(invalid)?;
    let suffix = resource_suffix(destination);
    Ok(format!(
        "{}{new_url}{suffix}{}",
        &original[..start],
        &original[end..]
    ))
}

fn destination_start(original: &str) -> Option<usize> {
    // 图片标签没有子节点位置；移除感叹号后按同一段 Markdown 链接语法定位。
    let input = original.strip_prefix('!').unwrap_or(original);
    let offset = original.len() - input.len();
    let tree = markdown::to_mdast(input, &markdown::ParseOptions::gfm()).ok()?;
    if let Some(link) = find_link(&tree) {
        let label_end = link
            .children
            .last()
            .and_then(Node::position)
            .map_or(1, |pos| pos.end.offset);
        return Some(offset + label_end + input.get(label_end..)?.find("](")? + 2);
    }
    if !tree
        .children()?
        .iter()
        .any(|node| matches!(node, Node::Definition(_)))
    {
        return None;
    }
    let bytes = input.as_bytes();
    let mut index = 1;
    while index + 1 < bytes.len() {
        if bytes[index] == b'\\' {
            index += 2;
            continue;
        }
        if bytes[index] == b']' && bytes[index + 1] == b':' {
            return Some(index + 2);
        }
        index += 1;
    }
    None
}

fn find_link(node: &Node) -> Option<&Link> {
    if let Node::Link(link) = node {
        return Some(link);
    }
    node.children()?.iter().find_map(find_link)
}

// 后缀连同原始转义一起保留，避免将标题或文件名里的实体错误解码第二次。
fn resource_suffix(raw: &str) -> &str {
    for (index, ch) in raw.char_indices() {
        if ch == '#' || ch == '?' {
            return &raw[index..];
        }
        if ch == '\\' && raw[index + 1..].starts_with(['#', '?']) {
            return &raw[index..];
        }
        if ch == '&' {
            if let Some(end) = raw[index..].find(';') {
                let entity = &raw[index..=index + end];
                if matches!(crate::wiki::decode_text(entity).as_str(), "#" | "?") {
                    return &raw[index..];
                }
            }
        }
    }
    ""
}

/// 从 `from_file` 出发指向 `to_file` 的 Markdown 相对 URL。
///
/// 同目录使用 `./文件名`，以便与常见写法一致。
/// # Errors
/// 生成的系统路径无法无损转换为协议文本时失败，不能改写为另一份文件的链接。
pub fn relative_markdown_url(from_file: &str, to_file: &str) -> Result<String, Error> {
    let from_dir = Path::new(from_file)
        .parent()
        .unwrap_or_else(|| Path::new(""));
    let to = Path::new(to_file);
    let from_parts = normal_parts(from_dir);
    let to_parts = normal_parts(to);
    let common = from_parts
        .iter()
        .zip(to_parts.iter())
        .take_while(|(a, b)| a == b)
        .count();
    let ups = from_parts.len().saturating_sub(common);
    let mut url = PathBuf::new();
    for _ in 0..ups {
        url.push("..");
    }
    for part in to_parts.iter().skip(common) {
        url.push(part);
    }
    let mut rendered = path_to_slashes(&url)?;
    if ups == 0 && !rendered.starts_with('.') {
        rendered = format!("./{rendered}");
    }
    Ok(rendered
        .split('/')
        .map(|part| utf8_percent_encode(part, PATH_COMPONENT).to_string())
        .collect::<Vec<_>>()
        .join("/"))
}

fn normal_parts(path: &Path) -> Vec<String> {
    path.components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect()
}

/// wiki 链接的新 target：目标文件的主文件名（不含扩展名）。
#[must_use]
pub fn wiki_target_name(to_file: &str) -> String {
    Path::new(to_file)
        .file_stem()
        .map_or_else(|| to_file.to_string(), |s| s.to_string_lossy().into_owned())
}

/// 路径形式 wiki 链接的新 target：保持原链接的形态。
///
/// 原目标带扩展名时改写为完整新路径；不带时去掉新路径的扩展名。
/// 目录前缀始终跟随新路径，避免改名把无歧义的路径链接降级成歧义名称链接。
#[must_use]
pub fn wiki_target_path(original_target: &str, to_file: &str) -> String {
    if Path::new(original_target).extension().is_some() {
        return to_file.to_string();
    }
    let path = Path::new(to_file);
    let Some(stem) = path.file_stem().map(|s| s.to_string_lossy().into_owned()) else {
        return to_file.to_string();
    };
    path_to_slashes(&path.with_file_name(stem)).unwrap_or_else(|_| to_file.to_string())
}
