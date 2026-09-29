use serde_json::Value;
use std::sync::{Arc, Mutex};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    task::JoinHandle,
};

/// 预设一轮 HTTP 响应，使协议边界测试无需外部模型账号或网络服务。
pub struct Fixture {
    /// 响应状态码，用于区分成功、可重试失败与永久失败。
    pub status: u16,
    /// 响应格式决定客户端采用 JSON、SSE 或其他协议解码。
    pub content_type: &'static str,
    /// 原始响应字节，允许构造不完整帧和无效编码。
    pub body: Vec<u8>,
}

impl Fixture {
    /// 将给定 JSON 编码为成功响应，返回可交给测试服务的预设数据。
    pub fn json(body: Value) -> Self {
        Self {
            status: 200,
            content_type: "application/json",
            body: body.to_string().into_bytes(),
        }
    }
    /// 按给定顺序编码 SSE 事件；done 控制是否附加 Chat 协议的终止标记。
    pub fn sse(events: Vec<Value>, done: bool) -> Self {
        let mut body = events
            .iter()
            .map(|value| format!("data: {value}\n\n"))
            .collect::<String>();
        if done {
            body.push_str("data: [DONE]\n\n");
        }
        Self {
            status: 200,
            content_type: "text/event-stream",
            body: body.into_bytes(),
        }
    }
}

/// 记录客户端实际发出的请求，用于断言鉴权、路径与消息映射。
#[derive(Clone, Debug)]
pub struct Request {
    /// 保留请求行和全部头部，避免测试夹具预先改写待验证内容。
    pub head: String,
    /// 解析后的 JSON 请求体，供各协议测试检查结构。
    pub body: Value,
}

/// 使用临时本地端口按顺序回放响应，释放时终止服务任务以隔离测试生命周期。
pub struct Server {
    /// 包含路径前缀的服务地址，同时验证客户端是否正确保留前缀。
    pub url: String,
    /// 已完整接收的请求，顺序与预设响应一致。
    pub requests: Arc<Mutex<Vec<Request>>>,
    task: Option<JoinHandle<()>>,
}

impl Server {
    /// 启动本地服务并依次回放 fixtures，返回地址与请求记录。
    ///
    /// # 恐慌
    /// 无法绑定本地端口时让测试立即失败；后台任务中的协议断言由 finish 传播。
    pub async fn start(fixtures: Vec<Fixture>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/api", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let captured = requests.clone();
        let task = tokio::spawn(async move {
            for fixture in fixtures {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut data = Vec::new();
                let mut buffer = [0; 4096];
                let header_end = loop {
                    let count = socket.read(&mut buffer).await.unwrap();
                    assert!(count > 0);
                    data.extend_from_slice(&buffer[..count]);
                    if let Some(end) = data.windows(4).position(|window| window == b"\r\n\r\n") {
                        break end + 4;
                    }
                };
                let head = String::from_utf8(data[..header_end].to_vec()).unwrap();
                let length = head
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|v| v.trim().parse::<usize>().unwrap())
                    })
                    .unwrap();
                while data.len() < header_end + length {
                    let count = socket.read(&mut buffer).await.unwrap();
                    assert!(count > 0);
                    data.extend_from_slice(&buffer[..count]);
                }
                let body = serde_json::from_slice(&data[header_end..header_end + length]).unwrap();
                captured.lock().unwrap().push(Request { head, body });
                let response = format!(
                    "HTTP/1.1 {} OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    fixture.status,
                    fixture.content_type,
                    fixture.body.len()
                );
                if socket.write_all(response.as_bytes()).await.is_err() {
                    continue;
                }
                // 故意切开 UTF-8 和 SSE/NDJSON 边界，覆盖网络分片。
                for chunk in fixture.body.chunks(7) {
                    if socket.write_all(chunk).await.is_err() {
                        break;
                    }
                    tokio::task::yield_now().await;
                }
            }
        });
        Self {
            url,
            requests,
            task: Some(task),
        }
    }

    /// 等待所有预设响应处理完毕，确保后台断言被测试调用方观察到。
    ///
    /// # 恐慌
    /// 后台任务失败或重复调用时使测试失败。
    pub async fn finish(&mut self) {
        self.task.take().unwrap().await.unwrap();
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}
