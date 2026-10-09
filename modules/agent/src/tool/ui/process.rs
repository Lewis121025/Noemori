//! 解释器进程只交换有界协议帧；外部副作用始终由 UiTool 的宿主分派器执行。
use super::{
    UiInput, UiOutput, UiTool,
    manager::Request,
    protocol::{FRAME_LIMIT, GuestFinished, GuestInput, GuestOutput},
};
use crate::Image;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    process::Stdio,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
};
pub(super) const ATTACHMENT_LIMIT: usize = 32 * 1024 * 1024;

/// 独立 QuickJS 进程及图片引用；不拥有任何浏览器或原生授权。
pub(super) struct Process {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    images: BTreeMap<String, Image>,
    image_order: VecDeque<String>,
    resources: BTreeSet<String>,
}
impl Process {
    /// 启动宿主指定的入口，使用独立标准流且不继承环境；失败不创建活动 JS 上下文。
    pub(super) fn start(tool: &UiTool) -> Result<Self, String> {
        let mut child = Command::new(tool.executable.as_ref())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .env_clear()
            .spawn()
            .map_err(|e| format!("启动 JS 执行进程失败：{e}"))?;
        Ok(Self {
            input: child.stdin.take().ok_or("JS 输入缺失")?,
            output: BufReader::new(child.stdout.take().ok_or("JS 输出缺失")?),
            child,
            images: Default::default(),
            image_order: Default::default(),
            resources: Default::default(),
        })
    }
    async fn send(&mut self, frame: GuestInput) -> Result<(), String> {
        let mut bytes = serde_json::to_vec(&frame).map_err(|e| e.to_string())?;
        if bytes.len() >= FRAME_LIMIT {
            return Err("JS 输入帧超限".into());
        }
        bytes.push(b'\n');
        self.input
            .write_all(&bytes)
            .await
            .map_err(|e| e.to_string())
    }
    async fn next(&mut self) -> Result<GuestOutput, String> {
        let mut bytes = Vec::new();
        let count = (&mut self.output)
            .take((FRAME_LIMIT + 1) as u64)
            .read_until(b'\n', &mut bytes)
            .await
            .map_err(|e| e.to_string())?;
        if count == 0 || count > FRAME_LIMIT {
            return Err("JS 输出已结束或超过帧上限".into());
        }
        serde_json::from_slice(&bytes).map_err(|e| format!("JS 协议无效：{e}"))
    }
    /// 在请求预算内消费能力调用并收齐输出；硬中断返回 reset，已记录动作不会重放。
    pub(super) async fn run(&mut self, request: &Request) -> Result<UiOutput, String> {
        let id = request.context.call_id.clone();
        let command = match &request.input {
            UiInput::Run { code, timeout_ms } => GuestInput::Run {
                id: id.clone(),
                code: code.clone(),
                timeout_ms: (*timeout_ms)
                    .min(
                        request
                            .context
                            .execution
                            .deadline
                            .saturating_duration_since(tokio::time::Instant::now())
                            .as_millis() as u64,
                    )
                    .max(1),
            },
            UiInput::Reset => GuestInput::Reset { id: id.clone() },
        };
        self.send(command).await?;
        let mut operations = Vec::new();
        let result = loop {
            let frame = match request.context.execution.wait(self.next()).await {
                Ok(result) => result,
                Err(error) => Err(error.to_string()),
            };
            match frame {
                Ok(GuestOutput::Call {
                    id: operation,
                    request: call,
                }) => {
                    if let Err(error) = self.invoke(request, operation, call, &mut operations).await
                    {
                        break Err(error);
                    }
                }
                Ok(GuestOutput::Finished(finished)) => {
                    break self.finish(finished, request, &mut operations);
                }
                Err(error) => break Err(error),
            }
        };
        match result {
            Ok(result) => Ok(result),
            Err(error) => {
                self.stop().await?;
                Ok(UiOutput {
                    prints: vec![],
                    images: vec![],
                    error: Some(error),
                    reset: true,
                    operations,
                })
            }
        }
    }
    async fn invoke(
        &mut self,
        request: &Request,
        operation: u64,
        call: Value,
        operations: &mut Vec<Value>,
    ) -> Result<(), String> {
        if operations.len() >= 256
            || serde_json::to_vec(&operations)
                .map_err(|error| error.to_string())?
                .len()
                >= 512 * 1024
        {
            return Err("SDK 调用次数或回执超过单次预算".into());
        }
        let id = &request.context.call_id;
        let mut context = request.context.clone();
        context.call_id = format!("{id}:{operation}");
        let result = request.tool.dispatch(call.clone(), context).await;
        let mut value = match result {
            Ok((mut value, image)) => {
                if let Some(image) = image {
                    self.remember_image(&mut value, image);
                }
                value
            }
            Err(error) => json!({"error":error.to_string(),"outcome":"not_executed"}),
        };
        self.describe_resource(&call, &mut value, &request.tool);
        let outcome = value.get("outcome").cloned().unwrap_or_else(|| {
            json!(if value.get("error").is_some() {
                "unknown"
            } else {
                "observed"
            })
        });
        operations.push(receipt(operation, &call, &value, &outcome));
        if serde_json::to_vec(&value).map_err(|e| e.to_string())?.len() > FRAME_LIMIT - 1024 {
            value = json!({"error":"SDK 结果超过控制帧上限；请分页读取","outcome":outcome});
        }
        self.send(GuestInput::Reply {
            id: operation,
            value,
        })
        .await?;
        Ok(())
    }
    fn finish(
        &mut self,
        finished: GuestFinished,
        request: &Request,
        operations: &mut Vec<Value>,
    ) -> Result<UiOutput, String> {
        let GuestFinished {
            id: finished,
            prints,
            images,
            error,
            reset,
        } = finished;
        if finished != request.context.call_id {
            return Err("JS 回执不属于当前调用".into());
        }
        let mut media = Vec::new();
        let mut image_error = None;
        for key in images {
            if let Some(image) = self.images.get(&key) {
                if media
                    .iter()
                    .map(|image: &Image| image.data().len())
                    .sum::<usize>()
                    + image.data().len()
                    > ATTACHMENT_LIMIT
                {
                    image_error = Some("本次图片附件超过 32 MiB，超出部分已省略".into());
                } else {
                    media.push(image.clone());
                }
            } else {
                image_error = Some("图片引用不存在或已经过期".to_owned());
            }
        }
        if !media.is_empty() && !request.tool.vision {
            image_error = Some("当前模型未声明视觉能力，图片附件未发送".into());
        }
        let mut output = UiOutput {
            prints,
            images: media,
            error: error.or(image_error),
            reset,
            operations: std::mem::take(operations),
        };
        if reset {
            self.images.clear();
            self.image_order.clear();
            self.resources.clear();
        }
        while serde_json::to_vec(&output)
            .map_err(|e| e.to_string())?
            .len()
            > FRAME_LIMIT
            && !output.prints.is_empty()
        {
            output.prints.pop();
            output.error = Some("总文字输出超过 1 MiB，尾部 print 已省略；动作事实仍保留".into());
        }
        if serde_json::to_vec(&output)
            .map_err(|e| e.to_string())?
            .len()
            > FRAME_LIMIT
        {
            return Err("动作回执超过总输出预算".into());
        }
        Ok(output)
    }
    fn remember_image(&mut self, value: &mut Value, image: Image) {
        let key = uuid::Uuid::new_v4().to_string();
        if let Some(object) = value.as_object_mut() {
            object.insert("image".into(), Value::String(key.clone()));
        }
        self.images.insert(key.clone(), image);
        self.image_order.push_back(key);
        while self.image_order.len() > 16
            || self
                .images
                .values()
                .map(|image| image.data().len())
                .sum::<usize>()
                > ATTACHMENT_LIMIT
        {
            if let Some(key) = self.image_order.pop_front() {
                self.images.remove(&key);
            }
        }
    }
    fn describe_resource(&mut self, call: &Value, value: &mut Value, tool: &UiTool) {
        let name = call["action"]["action"].as_str().unwrap_or("");
        if matches!(name, "tabs" | "apps" | "windows" | "observe" | "screenshot") {
            let resource = json!([
                call["domain"],
                call["backend"],
                call["action"].get("app"),
                call["action"].get("window")
            ])
            .to_string();
            if !self.resources.contains(&resource) {
                if self.resources.len() < 1024 {
                    self.resources.insert(resource);
                }
                value["sdk"] = tool.sdk_info(call);
            }
        }
    }
    /// 等待解释器进程回收；终止失败作为清理错误交给会话宿主。
    pub(super) async fn stop(&mut self) -> Result<(), String> {
        self.child
            .kill()
            .await
            .map_err(|e| format!("关闭 JS 执行进程失败：{e}"))
    }
}

fn bounded_text(value: &Value, limit: usize) -> Value {
    value
        .as_str()
        .map(|text| Value::String(text.chars().take(limit).collect()))
        .unwrap_or(Value::Null)
}

fn receipt(operation: u64, call: &Value, value: &Value, outcome: &Value) -> Value {
    let action = call.get("action").unwrap_or(&Value::Null);
    let mut target = serde_json::Map::new();
    for name in ["action", "page", "app", "window", "ref"] {
        if let Some(value) = action.get(name) {
            target.insert(name.into(), bounded_text(value, 256));
        }
    }
    let error = value
        .get("error")
        .and_then(Value::as_str)
        .map(|error| error.chars().take(1000).collect::<String>());
    let steps=value.get("steps").and_then(Value::as_array).map(|steps|steps.iter().take(16).map(|step|json!({"index":step.get("index"),"action":bounded_text(&step["action"],64),"outcome":bounded_text(&step["outcome"],32),"error":bounded_text(&step["error"],256)})).collect::<Vec<_>>());
    json!({"id":operation,"request":{"domain":bounded_text(&call["domain"],32),"backend":bounded_text(&call["backend"],32),"action":target},"outcome":outcome,"error":error,"steps":steps})
}
