//! 会话磁盘格式保持开放 JSON；所有读取先归一化，损坏字段不阻止恢复。

use crate::{Error, Result};
use serde::{
    de::{MapAccess, Visitor},
    Deserializer,
};
use serde_json::{json, value::RawValue, Map, Value};
use std::{
    collections::HashSet,
    fs,
    io::Write,
    path::{Path, PathBuf},
};

/// 应用会话的唯一持久化入口；调用由运行时顺序化，避免补丁互相覆盖。
pub struct SessionStore {
    file: PathBuf,
}

impl SessionStore {
    /// 绑定 userData 下的现有会话文件，不执行磁盘操作。
    #[must_use]
    pub fn new(user_data: &Path) -> Self {
        Self {
            file: user_data.join("session.json"),
        }
    }

    /// 读取并归一化；缺失、不可读或损坏时使用默认会话。
    #[must_use]
    pub fn load(&self) -> Value {
        self.read().unwrap_or_else(|| normalize(&Value::Null))
    }

    fn read(&self) -> Option<Value> {
        let raw = parse_json(&fs::read(&self.file).ok()?)?;
        raw.is_object().then(|| normalize(&raw))
    }

    /// 合并已校验的补丁并原子提交；提交前磁盘错误保留旧文件。
    /// # Errors
    /// 序列化、临时文件写入、同步或原子替换失败时返回错误。
    pub fn patch(&self, patch: &Value) -> Result<()> {
        let mut next = self.load();
        merge(&mut next, patch);
        self.save(&normalize(&next))
    }

    /// 更新阅读器字段，保留窗口和外观；失败不缓存成已提交状态。
    /// # Errors
    /// 序列化、临时文件写入、同步或原子替换失败时返回错误。
    pub fn patch_reader(&self, patch: &Value) -> Result<()> {
        let mut next = self.load();
        merge(&mut next["reader"], patch);
        self.save(&normalize(&next))
    }

    /// 写前重新比较磁盘，临时文件同步后原子替换；替换后不误报未提交。
    /// # Errors
    /// 序列化、临时文件写入、同步或原子替换失败时返回错误。
    pub fn save(&self, next: &Value) -> Result<()> {
        self.save_observed(next, |_| Ok(()))
    }

    fn save_observed(
        &self,
        next: &Value,
        mut before: impl FnMut(CommitStage) -> std::io::Result<()>,
    ) -> Result<()> {
        if self.read().as_ref() == Some(next) {
            return Ok(());
        }
        let parent = self
            .file
            .parent()
            .ok_or_else(|| Error::State("会话路径无父目录".into()))?;
        fs::create_dir_all(parent)?;
        let mut temporary = tempfile::Builder::new()
            .prefix(".session.")
            .suffix(".tmp")
            .tempfile_in(parent)?;
        let mut bytes = serde_json::to_vec_pretty(next).map_err(std::io::Error::other)?;
        bytes.push(b'\n');
        before(CommitStage::Write)?;
        temporary.write_all(&bytes)?;
        before(CommitStage::Sync)?;
        temporary.as_file().sync_all()?;
        before(CommitStage::Replace)?;
        temporary.persist(&self.file).map_err(|error| error.error)?;
        Ok(())
    }

    /// 已提交的路径变化同步到所有阅读现场；仅在实际变化时写盘。
    /// # Errors
    /// 序列化、临时文件写入、同步或原子替换失败时返回错误。
    pub fn remap(&self, from: &str, to: Option<&str>) -> Result<()> {
        let previous = self.load();
        let mut next = previous.clone();
        remap_reader(&mut next["reader"], from, to);
        if next != previous {
            self.save(&next)?;
        }
        Ok(())
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum CommitStage {
    Write,
    Sync,
    Replace,
}

// 旧 JavaScript 会话允许数值溢出和孤立 UTF-16 代理项，不能因此丢掉其它有效字段。
fn parse_json(bytes: &[u8]) -> Option<Value> {
    if let Ok(value) = serde_json::from_slice(bytes) {
        return Some(value);
    }
    let unit = |at: usize| -> Option<u16> {
        if bytes.get(at..at + 2)? != b"\\u" {
            return None;
        }
        u16::from_str_radix(std::str::from_utf8(bytes.get(at + 2..at + 6)?).ok()?, 16).ok()
    };
    let mut repaired = bytes.to_vec();
    let mut changed = false;
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] != b'\\' {
            at += 1;
            continue;
        }
        let Some(code) = unit(at) else {
            at += 2;
            continue;
        };
        if (0xd800..=0xdbff).contains(&code)
            && unit(at + 6).is_some_and(|low| (0xdc00..=0xdfff).contains(&low))
        {
            at += 12;
            continue;
        }
        if (0xd800..=0xdfff).contains(&code) {
            repaired[at + 2..at + 6].copy_from_slice(b"fffd");
            changed = true;
        }
        at += 6;
    }
    let raw = serde_json::from_slice::<&RawValue>(if changed { &repaired } else { bytes }).ok()?;
    recover_json_value(raw, 0)
}

// RawValue 先验证完整 JSON 语法，再逐值转换；只将无法表示的数字置空，由字段归一化决定回退。
// 不开启全局 arbitrary_precision，避免改变 Vault 游标及 N-API 数字序列化的语义。
fn recover_json_value(raw: &RawValue, depth: usize) -> Option<Value> {
    if depth >= 128 {
        return None;
    }
    let source = raw.get();
    if let Ok(value) = serde_json::from_str(source) {
        return Some(value);
    }
    match source.as_bytes().first()? {
        b'{' => serde_json::Deserializer::from_str(source)
            .deserialize_map(RecoveredObject(depth + 1))
            .ok(),
        b'[' => serde_json::from_str::<Vec<&RawValue>>(source)
            .ok()?
            .into_iter()
            .map(|value| recover_json_value(value, depth + 1))
            .collect::<Option<Vec<_>>>()
            .map(Value::Array),
        b'-' | b'0'..=b'9' => source.parse::<f64>().ok().map(|number| json!(number)),
        _ => None,
    }
}

/// 保序读取对象字段；任一无效 JSON 子值使恢复失败，不把语法损坏伪装成合法会话。
struct RecoveredObject(usize);

impl<'de> Visitor<'de> for RecoveredObject {
    type Value = Value;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("JSON 对象")
    }

    fn visit_map<M: MapAccess<'de>>(self, mut fields: M) -> std::result::Result<Value, M::Error> {
        let mut values = Map::new();
        while let Some((key, raw)) = fields.next_entry::<String, &RawValue>()? {
            let value = recover_json_value(raw, self.0)
                .ok_or_else(|| serde::de::Error::custom("会话字段无法恢复"))?;
            values.insert(key, value);
        }
        Ok(Value::Object(values))
    }
}

#[cfg(test)]
#[path = "../../../../../test/notes/runtime/unit/session.rs"]
mod tests;

fn merge(target: &mut Value, patch: &Value) {
    if let (Some(target), Some(patch)) = (target.as_object_mut(), patch.as_object()) {
        target.extend(patch.clone());
    }
}

fn text(value: &Value) -> Value {
    value
        .as_str()
        .filter(|s| !s.is_empty())
        .map_or(Value::Null, |s| json!(s))
}

fn paths(value: &Value, limit: usize, strict: bool) -> Vec<Value> {
    let mut seen = HashSet::new();
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|s| !s.is_empty() && (!strict || entry_path(s)))
        .filter(|s| seen.insert(*s))
        .take(limit)
        .map(|s| json!(s))
        .collect()
}

/// 协议相对路径校验；反斜杠在 Unix 上是合法文件名，最终边界仍由 Vault 检查。
pub(crate) fn entry_path(path: &str) -> bool {
    !path.is_empty()
        && !path.contains('\0')
        && !path.split('/').any(|p| matches!(p, "" | "." | ".."))
}

fn position(value: &Value) -> Option<Value> {
    let inset = value["inset"].as_f64()?;
    let source = &value["source"];
    let offset = source["offset"].as_f64()?;
    let before = source["before"].as_str()?;
    let after = source["after"].as_str()?;
    if inset.abs() > 100_000.0
        || !(0.0..=9_007_199_254_740_991.0).contains(&offset)
        || offset.fract() != 0.0
        || before.encode_utf16().count() > 64
        || after.encode_utf16().count() > 64
    {
        return None;
    }
    Some(
        json!({"source": {"offset": source["offset"], "before": before, "after": after}, "inset": value["inset"]}),
    )
}

fn history(value: &Value) -> Value {
    let entries = |side: &str| -> Vec<Value> {
        value[side]
            .as_array()
            .into_iter()
            .flatten()
            .take(100)
            .filter_map(|item| {
                let path = text(&item["path"]);
                if path.is_null() {
                    return None;
                }
                let mut result = json!({"path": path, "anchor": text(&item["anchor"])});
                if let Some(p) = position(&item["position"]) {
                    result["position"] = p;
                }
                Some(result)
            })
            .collect()
    };
    json!({"back": entries("back"), "forward": entries("forward")})
}

/// 空文档会话；每次创建独立数据，切库不携带旧阅读现场。
#[must_use]
pub fn empty_documents() -> Value {
    json!({"panes": [{"currentPath": null, "history": {"back": [], "forward": []}}], "active": 0, "split": false})
}

fn documents(value: &Value, legacy: &Value) -> Value {
    let Some(panes) = value["panes"].as_array() else {
        return json!({"panes": [{"currentPath": text(&legacy["currentPath"]), "history": history(&legacy["history"])}], "active": 0, "split": false});
    };
    let mut panes: Vec<Value> = panes
        .iter()
        .take(2)
        .map(|pane| {
            let current = text(&pane["currentPath"]);
            let mut result = json!({"currentPath": current, "history": history(&pane["history"])});
            if !current.is_null() {
                if let Some(p) = position(&pane["position"]) {
                    result["position"] = p;
                }
            }
            result
        })
        .collect();
    if panes.is_empty() {
        panes.push(empty_documents()["panes"][0].clone());
    }
    // JSON 的 1、1.0 与 1e0 在 JavaScript 中是同一整数；两栏协议只允许 0 或 1。
    let active = usize::from(value["active"].as_f64() == Some(1.0) && panes.len() == 2);
    json!({"active": active, "split": value["split"] == true && panes.len() == 2, "panes": panes})
}

fn file_tree(value: &Value) -> Value {
    if !value.is_object() {
        return Value::Null;
    }
    let path = |v: &Value| {
        v.as_str()
            .filter(|s| entry_path(s))
            .map_or(Value::Null, |s| json!(s))
    };
    let focused = path(&value["focused"]);
    let mut scroll = Value::Null;
    if let Some(offset) = value["scroll"]["offset"].as_f64() {
        let p = path(&value["scroll"]["path"]);
        if !p.is_null() {
            scroll = json!({"path": p, "offset": offset.clamp(0.0, 500.0)});
        }
    }
    let mut result = json!({"expanded": paths(&value["expanded"], usize::MAX, true),
        "selected": paths(&value["selected"], usize::MAX, true), "focused": focused, "scroll": scroll});
    let browse = &value["browse"];
    if browse["query"].is_string()
        && matches!(
            browse["section"].as_str(),
            Some("files" | "tags" | "bookmarks")
        )
    {
        result["browse"] = json!({"query": browse["query"], "section": browse["section"]});
    }
    result
}

/// 兼容旧平铺格式并逐字段恢复；输出是唯一的新格式，未知字段不继续传播。
#[must_use]
pub fn normalize(value: &Value) -> Value {
    let reader = value.get("reader").unwrap_or(value);
    let mut modes = Map::new();
    if let Some(items) = reader["viewModes"].as_object() {
        for (path, mode) in items
            .iter()
            .filter(|(p, m)| !p.is_empty() && matches!(m.as_str(), Some("source" | "reading")))
            .take(500)
        {
            modes.insert(path.clone(), mode.clone());
        }
    } else {
        for path in paths(&reader["sourceViews"], 500, false) {
            if let Some(path) = path.as_str() {
                modes.insert(path.into(), json!("source"));
            }
        }
    }
    let width = reader["leftWidth"]
        .as_f64()
        .map_or(232.0, |n| (n + 0.5).floor().clamp(192.0, 480.0));
    let mut r = json!({"vaultRoot": text(&reader["vaultRoot"]), "documents": documents(&reader["documents"], reader),
        "viewModes": modes, "recentFiles": paths(&reader["recentFiles"], 50, false), "fileTree": file_tree(&reader["fileTree"]),
        "filesCollapsed": reader["filesCollapsed"] == true, "leftWidth": width});
    if matches!(
        reader["space"].as_str(),
        Some("writing" | "library" | "connections")
    ) {
        r["space"] = reader["space"].clone();
    }
    let w = &value["window"];
    let window = if ["x", "y", "width", "height"]
        .iter()
        .all(|key| w[key].as_f64().is_some())
    {
        json!({"x": session_number(&w["x"]), "y": session_number(&w["y"]),
            "width": session_number(&w["width"]), "height": session_number(&w["height"]), "maximized": w["maximized"] == true})
    } else {
        Value::Null
    };
    let appearance = value["appearance"]
        .as_str()
        .filter(|s| matches!(*s, "light" | "dark" | "system"))
        .unwrap_or("system");
    json!({"appearance": appearance, "reader": r, "window": window})
}

// 旧会话数字采用 JavaScript 双精度语义；超出安全整数的值也必须保持 number，而非跨语言恢复成 bigint。
fn session_number(value: &Value) -> Value {
    value
        .as_f64()
        .filter(|number| number.abs() > 9_007_199_254_740_991.0)
        .map_or_else(|| value.clone(), |number| json!(number))
}

fn remap_reader(reader: &mut Value, from: &str, to: Option<&str>) {
    let map = |value: &Value| -> Value {
        let Some(path) = value.as_str() else {
            return value.clone();
        };
        if path == from
            || path
                .strip_prefix(from)
                .is_some_and(|tail| tail.starts_with('/'))
        {
            to.map_or(Value::Null, |to| {
                json!(format!("{to}{}", &path[from.len()..]))
            })
        } else {
            value.clone()
        }
    };
    let map_list = |value: &mut Value, dedup: bool| {
        if let Some(items) = value.as_array_mut() {
            let mut seen = HashSet::new();
            *items = items
                .iter()
                .map(&map)
                .filter(|v| !v.is_null() && (!dedup || seen.insert(v.to_string())))
                .collect();
        }
    };
    if let Some(panes) = reader["documents"]["panes"].as_array_mut() {
        for pane in panes {
            pane["currentPath"] = map(&pane["currentPath"]);
            for side in ["back", "forward"] {
                if let Some(entries) = pane["history"][side].as_array_mut() {
                    entries.retain_mut(|item| {
                        item["path"] = map(&item["path"]);
                        !item["path"].is_null()
                    });
                }
            }
        }
    }
    if let Some(modes) = reader["viewModes"].as_object_mut() {
        *modes = std::mem::take(modes)
            .into_iter()
            .filter_map(|(path, mode)| map(&json!(path)).as_str().map(|p| (p.into(), mode)))
            .collect();
    }
    map_list(&mut reader["recentFiles"], false);
    let tree = &mut reader["fileTree"];
    if tree.is_object() {
        for field in ["expanded", "selected"] {
            map_list(&mut tree[field], true);
        }
        tree["focused"] = map(&tree["focused"]);
        if tree["scroll"].is_object() {
            tree["scroll"]["path"] = map(&tree["scroll"]["path"]);
            if tree["scroll"]["path"].is_null() {
                tree["scroll"] = Value::Null;
            }
        }
    }
}
