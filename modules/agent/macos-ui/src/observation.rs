//! 原生 AX 观察的增量编码；采集仍使用真实 AX 树，不依赖不完备的通知缓存。
use serde_json::{Value, json};

/// 将实际完整 AX 观察编码为可还原的增量，旧观察失效时明确回退完整结果。
/// previous 必须属于当前会话和窗口；mode 为 full 或 delta，baseline 为调用者保留的身份。
/// 返回仅含 observation 或 observation_update 的对象；格式或模式无效时返回错误。
pub(crate) fn result(
    previous: Option<&Value>,
    current: &Value,
    mode: &str,
    baseline: Option<&str>,
) -> Result<Value, String> {
    if mode == "full" {
        return Ok(json!({"observation":current}));
    }
    if mode != "delta" {
        return Err("观察模式必须是 full 或 delta".into());
    }
    let id = current["id"].as_str().ok_or("观察缺少身份")?;
    let target = current["window"].as_str().ok_or("观察缺少窗口")?;
    let truncated = current["truncated"].as_bool().ok_or("观察缺少截断事实")?;
    let reset = match (baseline, previous) {
        (None, _) => Some("missing_baseline"),
        (Some(_), None) => Some("invalidated"),
        (Some(_), Some(previous)) if previous["window"] != target => Some("invalidated"),
        (Some(baseline), Some(previous)) if previous["id"] != baseline => Some("baseline_mismatch"),
        _ => None,
    };
    if let Some(reason) = reset {
        return Ok(
            json!({"observation":current,"observation_update":{"kind":"full","id":id,"target":target,"truncated":truncated,"reset_reason":reason}}),
        );
    }
    let previous = previous.ok_or("观察增量缺少基线")?;
    let baseline = baseline.ok_or("观察增量缺少基线身份")?;
    let mut changes = serde_json::Map::new();
    for (key, value) in current.as_object().ok_or("观察必须为对象")? {
        if !matches!(key.as_str(), "id" | "window") && previous[key] != *value {
            changes.insert(key.clone(), value.clone());
        }
    }
    Ok(
        json!({"observation_update":{"kind":if changes.is_empty(){"unchanged"}else{"delta"},"id":id,"target":target,"base":baseline,"truncated":truncated,"changes":changes}}),
    )
}
