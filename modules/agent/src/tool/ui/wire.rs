//! 本地传输与 Native Messaging 共用有界分块，模型不能访问连接密钥。
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::io::{Read, Write};
/// Native Messaging 单个 JSON 帧的硬上限，不包含四字节长度前缀。
pub const MESSAGE_LIMIT: usize = 1024 * 1024;
const PAYLOAD_LIMIT: usize = 64 * 1024 * 1024;
const CHUNK: usize = 192 * 1024;

/// 将一条 JSON 消息切成有界 Native Messaging 帧；长度按宿主原生字节序编码。
/// 写入错误、JSON 编码或总载荷超限时返回错误，不继续发送剩余分块。
pub fn write_message(writer: &mut impl Write, value: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    if bytes.len() > PAYLOAD_LIMIT {
        return Err("UI 消息超过 64 MiB".into());
    }
    if bytes.len() < MESSAGE_LIMIT {
        return write_frame(writer, &bytes);
    }
    let transfer = uuid::Uuid::new_v4().to_string();
    for (index, chunk) in bytes.chunks(CHUNK).enumerate() {
        let frame = json!({"type":"chunk","transfer":transfer,"offset":index*CHUNK,"total":bytes.len(),"data":STANDARD.encode(chunk)});
        write_frame(
            writer,
            &serde_json::to_vec(&frame).map_err(|e| e.to_string())?,
        )?;
    }
    Ok(())
}
fn write_frame(writer: &mut impl Write, bytes: &[u8]) -> Result<(), String> {
    writer
        .write_all(&(bytes.len() as u32).to_ne_bytes())
        .and_then(|()| writer.write_all(bytes))
        .and_then(|()| writer.flush())
        .map_err(|e| e.to_string())
}

/// 读取一条完整有界消息；分块必须连续、同一身份且总长度一致。
/// EOF、超限、乱序、混入普通消息或无效 JSON 均返回错误。
pub fn read_message(reader: &mut impl Read) -> Result<Value, String> {
    let first = read_frame(reader)?;
    if first.get("type").and_then(Value::as_str) != Some("chunk") {
        return Ok(first);
    }
    let total = first
        .get("total")
        .and_then(Value::as_u64)
        .filter(|n| *n <= PAYLOAD_LIMIT as u64 && *n > 0)
        .ok_or("UI 分块总长度无效")? as usize;
    let transfer = first
        .get("transfer")
        .and_then(Value::as_str)
        .filter(|v| v.len() <= 128)
        .ok_or("UI 分块身份无效")?
        .to_owned();
    let mut bytes = Vec::new();
    let mut frame = first;
    loop {
        if frame.get("type").and_then(Value::as_str) != Some("chunk")
            || frame.get("transfer").and_then(Value::as_str) != Some(transfer.as_str())
            || frame.get("total").and_then(Value::as_u64) != Some(total as u64)
            || frame.get("offset").and_then(Value::as_u64) != Some(bytes.len() as u64)
        {
            return Err("UI 分块乱序或身份发生变化".into());
        }
        let data = frame
            .get("data")
            .and_then(Value::as_str)
            .ok_or("UI 分块缺少数据")?;
        let chunk = STANDARD.decode(data).map_err(|_| "UI 分块编码无效")?;
        if chunk.is_empty() || chunk.len() > CHUNK || chunk.len() > total - bytes.len() {
            return Err("UI 分块数据超限".into());
        }
        bytes.extend(chunk);
        if bytes.len() == total {
            return serde_json::from_slice(&bytes).map_err(|e| e.to_string());
        }
        frame = read_frame(reader)?;
    }
}
fn read_frame(reader: &mut impl Read) -> Result<Value, String> {
    let mut length = [0; 4];
    reader.read_exact(&mut length).map_err(|e| e.to_string())?;
    let length = u32::from_ne_bytes(length) as usize;
    if length == 0 || length > MESSAGE_LIMIT {
        return Err("UI 传输帧长度无效".into());
    }
    let mut bytes = vec![0; length];
    reader.read_exact(&mut bytes).map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}
