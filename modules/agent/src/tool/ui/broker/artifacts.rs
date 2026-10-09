//! 下载先占用会话配额，文件 I/O 完成后重新核验租约；保存期间不持有全局状态锁。
use super::{Artifact, Inner, State};
use crate::tool::ui::files::FILE_LIMIT;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::Value;
use std::{fs, io::Write, os::unix::fs::PermissionsExt, path::Path};

/// 占位与落盘使用同一标识；失败、撤销或连接关闭都释放尚未完成的配额。
struct Reservation<'a> {
    owner: &'a Inner,
    id: String,
    session: String,
}
impl Drop for Reservation<'_> {
    fn drop(&mut self) {
        self.owner
            .state
            .lock()
            .expect("UI broker 状态锁被污染")
            .saving
            .remove(&self.id);
    }
}

fn authorize<'a>(
    state: &'a State,
    connection: &str,
    session: &str,
    page: &str,
) -> Result<&'a str, String> {
    let port = state.ports.get(connection).ok_or("下载连接不存在")?;
    if !state.sessions.contains_key(session)
        || !port.view.connected
        || !port.shares.get(session).is_some_and(|tabs| {
            tabs.iter()
                .any(|tab| tab.get("id").and_then(Value::as_str) == Some(page))
        })
    {
        return Err("下载不属于仍有效的共享页面与会话".into());
    }
    Ok(&port.view.backend)
}

fn reserve<'a>(
    owner: &'a Inner,
    connection: &str,
    frame: &Value,
) -> Result<Reservation<'a>, String> {
    let id = frame["id"]
        .as_str()
        .filter(|id| uuid::Uuid::parse_str(id).is_ok())
        .ok_or("下载身份无效")?;
    let session = frame["session"].as_str().ok_or("下载缺少会话")?;
    let page = frame["page"].as_str().ok_or("下载缺少页面")?;
    let mut state = owner.state.lock().expect("UI broker 状态锁被污染");
    authorize(&state, connection, session, page)?;
    let count = state
        .artifacts
        .values()
        .filter(|file| file.session == session)
        .count()
        + state
            .saving
            .values()
            .filter(|owner| owner.as_str() == session)
            .count();
    if state.artifacts.contains_key(id) || state.saving.contains_key(id) || count >= 100 {
        return Err("下载身份重复或达到会话数量上限".into());
    }
    state.saving.insert(id.into(), session.into());
    Ok(Reservation {
        owner,
        id: id.into(),
        session: session.into(),
    })
}

/// 只有完整文件与当前租约同时有效才提交元数据；返回值只含公开下载 id 与字节数。
/// 格式、配额、文件写入或结算前撤销失败时返回错误，临时文件由 TempPath 回收。
pub(super) fn save(
    owner: &Inner,
    connection: &str,
    frame: &Value,
) -> Result<(String, u64), String> {
    let reservation = reserve(owner, connection, frame)?;
    let data = frame["data"]
        .as_str()
        .filter(|data| data.len() <= FILE_LIMIT * 4 / 3 + 4)
        .ok_or("下载字节超过预算")?;
    let bytes = STANDARD.decode(data).map_err(|_| "下载数据编码无效")?;
    if bytes.len() > FILE_LIMIT {
        return Err("下载文件超过预算".into());
    }
    let name = frame["name"]
        .as_str()
        .filter(|name| name.len() <= 8192)
        .and_then(|name| Path::new(name).file_name())
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .ok_or("下载名称无效")?;
    let directory = owner.directory.join("downloads");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
        .map_err(|error| error.to_string())?;
    let mut file =
        tempfile::NamedTempFile::new_in(&directory).map_err(|error| error.to_string())?;
    file.write_all(&bytes).map_err(|error| error.to_string())?;
    file.as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    let path = file.into_temp_path();
    let page = frame["page"].as_str().ok_or("下载缺少页面")?;
    let mut state = owner.state.lock().expect("UI broker 状态锁被污染");
    let backend = authorize(&state, connection, &reservation.session, page)?.to_owned();
    state.artifacts.insert(
        reservation.id.clone(),
        Artifact {
            session: reservation.session.clone(),
            backend,
            page: page.into(),
            name: name.into(),
            bytes: bytes.len() as u64,
            path,
        },
    );
    // 先释放状态锁，再销毁占位守卫；Guard 的清理不得重入同一把锁。
    drop(state);
    Ok((reservation.id.clone(), bytes.len() as u64))
}
