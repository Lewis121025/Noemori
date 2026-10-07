use super::{manager::Request, *};
use crate::{
    CancellationToken, ImageFormat,
    tool::web::process::{ProcessRole, Resources},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{ChildStdin, ChildStdout},
    sync::{mpsc, watch},
};

// 读取缓冲归通道所有；取消一轮等待不能丢失已经收到的半条 JSON 回执。
struct Channel {
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    buffer: Vec<u8>,
}
impl Channel {
    async fn next_result(
        &mut self,
        snapshot: &Arc<Mutex<BrowserSnapshot>>,
        changed: &Arc<dyn Fn() + Send + Sync>,
    ) -> Result<Value, String> {
        loop {
            let frame = self.read().await?;
            if frame["kind"] == "proxy_request" {
                let id = frame["id"].as_str().ok_or("代理请求缺少标识")?;
                let source = frame["url"].as_str().ok_or("代理请求缺少来源")?;
                let result = crate::tool::web::network::proxy_for(source);
                let response = match result {
                    Ok(proxy) => json!({"kind":"proxy_ready","id":id,"proxy":proxy}),
                    Err(error) => json!({"kind":"proxy_ready","id":id,"error":error}),
                };
                self.send(response).await?;
                continue;
            }
            if frame["kind"] != "state" {
                return Ok(frame);
            }
            let tabs = serde_json::from_value(frame["tabs"].clone())
                .map_err(|error| format!("浏览器状态帧无效：{error}"))?;
            snapshot.lock().expect("浏览器状态锁被污染").tabs = tabs;
            changed();
        }
    }
    async fn send(&mut self, value: Value) -> Result<(), String> {
        let mut bytes = serde_json::to_vec(&value).map_err(|error| error.to_string())?;
        bytes.push(b'\n');
        self.stdin
            .write_all(&bytes)
            .await
            .map_err(|error| format!("浏览器命令写入失败：{error}"))
    }
    async fn read(&mut self) -> Result<Value, String> {
        loop {
            let available = self
                .stdout
                .fill_buf()
                .await
                .map_err(|error| format!("浏览器回执读取失败：{error}"))?;
            if available.is_empty() {
                return Err("浏览器在回执完成前退出".into());
            }
            let length = available
                .iter()
                .position(|byte| *byte == b'\n')
                .map_or(available.len(), |index| index + 1);
            if self.buffer.len() + length > 16 * 1024 * 1024 {
                return Err("浏览器回执超过 16 MiB".into());
            }
            let end = available[length - 1] == b'\n';
            self.buffer.extend_from_slice(&available[..length]);
            self.stdout.consume(length);
            if end {
                break;
            }
        }
        let frame: Value = serde_json::from_slice(&std::mem::take(&mut self.buffer))
            .map_err(|error| format!("浏览器回执 JSON 无效：{error}"))?;
        if frame["kind"] == "failed" {
            return Err(frame["error"]
                .as_str()
                .unwrap_or("浏览器运行时失败")
                .to_owned());
        }
        Ok(frame)
    }
}

/// 持有 Node 与浏览器资源直到 actor 结束，取消启动或运行同样须等待清理。
/// config 是宿主冻结配置，requests 是唯一动作入口，cancellation 只关闭本会话资源。
/// snapshot 与 changed 保留执行事实，finished 在清理结算后发布结果；运行失败写入快照。
pub(super) async fn run(
    config: Arc<BrowserConfig>,
    mut requests: mpsc::Receiver<Request>,
    cancellation: CancellationToken,
    snapshot: Arc<Mutex<BrowserSnapshot>>,
    changed: Arc<dyn Fn() + Send + Sync>,
    finished: watch::Sender<Option<Result<(), String>>>,
) {
    let mut resources = Resources::default();
    let result = tokio::select! {
        biased;
        () = cancellation.cancelled() => Ok(()),
        result = drive(&config, &mut resources, &mut requests, &snapshot, &changed) => result,
    };
    // 浏览器与 Node 都归 Resources；取消启动或丢弃正在执行的协议同样必须回收。
    let cleanup = resources.cleanup().await;
    {
        let mut state = snapshot.lock().expect("浏览器状态锁被污染");
        state.status = if result.is_err() {
            BrowserStatus::Failed
        } else {
            BrowserStatus::Closed
        };
        state.error = result.err().or_else(|| cleanup.as_ref().err().cloned());
        if cleanup.is_ok() {
            state.tabs.clear();
        }
    }
    changed();
    finished.send_replace(Some(cleanup));
}

async fn drive(
    config: &BrowserConfig,
    resources: &mut Resources,
    requests: &mut mpsc::Receiver<Request>,
    snapshot: &Arc<Mutex<BrowserSnapshot>>,
    changed: &Arc<dyn Fn() + Send + Sync>,
) -> Result<(), String> {
    let mut channel = tokio::time::timeout(
        Duration::from_secs(30),
        start(config, resources, snapshot, changed),
    )
    .await
    .map_err(|_| "浏览器启动超过 30 秒")??;
    snapshot.lock().expect("浏览器状态锁被污染").status = BrowserStatus::Ready;
    changed();
    let mut completed: HashMap<String, (Value, BrowserOutput)> = HashMap::new();
    loop {
        let request = tokio::select! {
            request = requests.recv() => match request { Some(request) => request, None => break },
            frame = channel.next_result(snapshot, changed) => return Err(match frame { Err(error) => error, Ok(_) => "空闲浏览器返回了意外控制帧".into() }),
        };
        let action = serde_json::to_value(&request.action).map_err(|error| error.to_string())?;
        if let Some((previous, output)) = completed.get(&request.id) {
            let result = if previous == &action {
                Ok(output.clone())
            } else {
                Err("工具调用标识已经用于另一个浏览器动作".into())
            };
            let _ = request.reply.send(result);
            continue;
        }
        if completed.len() >= 4096 {
            return Err("浏览器会话达到动作上限，请检查任务是否陷入循环".into());
        }
        if request.context.check().is_err() || request.reply.is_closed() {
            continue;
        }
        snapshot.lock().expect("浏览器状态锁被污染").status = BrowserStatus::Busy;
        changed();
        let result = exchange(&mut channel, &request, action.clone(), snapshot, changed).await;
        let mut output = match result {
            Ok(output) => output,
            Err(error) => {
                record(
                    snapshot,
                    BrowserReceipt {
                        steps: Vec::new(),
                        call_id: request.id.clone(),
                        action: action["action"].as_str().unwrap_or_default().into(),
                        outcome: BrowserOutcome::Unknown,
                        error: Some(error.clone()),
                    },
                );
                let _ = request.reply.send(Err(error.clone()));
                return Err(error);
            }
        };
        record(
            snapshot,
            BrowserReceipt {
                steps: output.steps.clone(),
                call_id: request.id.clone(),
                action: action["action"].as_str().unwrap_or_default().into(),
                outcome: output.outcome.clone(),
                error: output.error.clone(),
            },
        );
        {
            let mut state = snapshot.lock().expect("浏览器状态锁被污染");
            state.status = if matches!(output.mode, BrowserMode::Human) {
                BrowserStatus::Human
            } else {
                BrowserStatus::Ready
            };
            state.tabs = output.tabs.clone();
            output.recent_operations = state.receipts.clone();
        }
        let mut retained = output.clone();
        retained.image = None;
        retained.observation = None;
        retained.recent_operations.clear();
        completed.insert(request.id.clone(), (action, retained));
        changed();
        let _ = request.reply.send(Ok(output));
    }
    Ok(())
}

fn record(snapshot: &Arc<Mutex<BrowserSnapshot>>, receipt: BrowserReceipt) {
    let mut state = snapshot.lock().expect("浏览器状态锁被污染");
    if state.receipts.len() == 32 {
        state.receipts.remove(0);
    }
    state.receipts.push(receipt);
}

async fn start(
    config: &BrowserConfig,
    resources: &mut Resources,
    snapshot: &Arc<Mutex<BrowserSnapshot>>,
    changed: &Arc<dyn Fn() + Send + Sync>,
) -> Result<Channel, String> {
    let directory = resources.directory("noemori-browser-downloads-")?;
    let node = resources.spawn(config.node.as_os_str(), ProcessRole::Node, |command| {
        command
            .args(["--max-old-space-size=512", "--use-system-ca"])
            .arg(&config.worker)
            .env("ELECTRON_RUN_AS_NODE", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
    })?;
    let stdin = resources
        .child(node)
        .stdin()
        .take()
        .ok_or("浏览器运行时缺少输入管道")?;
    let stdout = resources
        .child(node)
        .stdout()
        .take()
        .ok_or("浏览器运行时缺少输出管道")?;
    let mut channel = Channel {
        stdin,
        stdout: BufReader::new(stdout),
        buffer: Vec::new(),
    };
    channel.send(json!({"workspace":config.workspace,"download_directory":directory,"browser_path":config.browser,"private_origins":config.private_origins,"max_pages":12,"max_chars":24000,"max_elements":250,"max_download_bytes":33554432,"max_network_bytes":536870912})).await?;
    let start = channel.read().await?;
    if start["kind"] != "browser_start" {
        return Err("浏览器运行时没有请求资源分配".into());
    }
    let executable = start["executable"].as_str().ok_or("缺少浏览器可执行文件")?;
    if let Some(expected) = &config.browser
        && expected.as_os_str() != executable
    {
        return Err("浏览器运行时试图更改宿主程序".into());
    }
    let proxy = start["proxy_url"].as_str().ok_or("缺少浏览器受控出口")?;
    let (pid, endpoint) = resources
        .browser_window(executable.as_ref(), proxy, config.headless)
        .await?;
    channel
        .send(json!({"kind":"browser_ready","pid":pid,"endpoint":endpoint}))
        .await?;
    if channel.next_result(snapshot, changed).await?["kind"] != "ready" {
        return Err("浏览器运行时未完成初始化".into());
    }
    Ok(channel)
}

async fn exchange(
    channel: &mut Channel,
    request: &Request,
    action: Value,
    snapshot: &Arc<Mutex<BrowserSnapshot>>,
    changed: &Arc<dyn Fn() + Send + Sync>,
) -> Result<BrowserOutput, String> {
    let timeout = request
        .context
        .deadline
        .saturating_duration_since(tokio::time::Instant::now())
        .min(Duration::from_secs(30));
    channel.send(json!({"kind":"execute","id":request.id,"action":action,"timeout_ms":timeout.as_millis().max(1)})).await?;
    let frame = tokio::select! {
        biased;
        () = request.context.cancellation.cancelled() => None,
        () = tokio::time::sleep(timeout) => None,
        frame = channel.next_result(snapshot, changed) => Some(frame?),
    };
    let frame = match frame {
        Some(frame) => frame,
        None => {
            channel
                .send(json!({"kind":"cancel","id":request.id}))
                .await?;
            tokio::time::timeout(
                Duration::from_secs(12),
                channel.next_result(snapshot, changed),
            )
            .await
            .map_err(|_| "浏览器动作取消后仍未结算，副作用未知，关闭运行时")??
        }
    };
    if frame["kind"] != "result" || frame["id"].as_str() != Some(&request.id) {
        return Err("浏览器回执不属于当前动作".into());
    }
    let mut output: BrowserOutput = serde_json::from_value(frame["result"].clone())
        .map_err(|error| format!("浏览器结果契约无效：{error}"))?;
    if let Some(image) = frame["result"].get("image") {
        if image["format"] != "jpeg" {
            return Err("浏览器截图格式无效".into());
        }
        let bytes = STANDARD
            .decode(image["data"].as_str().ok_or("浏览器截图载荷缺失")?)
            .map_err(|error| error.to_string())?;
        output.image =
            Some(Image::new(ImageFormat::Jpeg, bytes).map_err(|error| error.to_string())?);
    }
    Ok(output)
}
