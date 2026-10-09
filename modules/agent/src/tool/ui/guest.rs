use super::protocol::{FRAME_LIMIT, GuestFinished, GuestInput, GuestOutput};
use rquickjs::{AsyncContext, AsyncRuntime, Ctx, Exception, Function, Value, function::Async};
use serde_json::Value as Json;
use std::{
    collections::BTreeMap,
    io::{BufRead, Write},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::{mpsc, oneshot};

#[derive(Default)]
/// 单次脚本的文字和图片引用预算；图片字节始终留在宿主媒体通道。
struct Output {
    prints: Vec<Json>,
    images: Vec<String>,
    bytes: usize,
}
type Replies = Arc<Mutex<BTreeMap<u64, oneshot::Sender<String>>>>;

fn write(frame: &GuestOutput) -> Result<(), String> {
    let bytes = serde_json::to_vec(frame).map_err(|e| e.to_string())?;
    if bytes.len() > FRAME_LIMIT {
        return Err("执行进程输出帧超限".into());
    }
    let mut stdout = std::io::stdout().lock();
    stdout
        .write_all(&bytes)
        .and_then(|()| stdout.write_all(b"\n"))
        .and_then(|()| stdout.flush())
        .map_err(|e| e.to_string())
}

fn exception(ctx: &Ctx<'_>, error: rquickjs::Error) -> String {
    if error.is_exception() {
        let value = ctx.catch();
        if let Some(error) = value.clone().into_object().and_then(Exception::from_object) {
            return error.to_string();
        }
        return format!("JavaScript 异常：{value:?}");
    }
    error.to_string()
}

async fn context(
    runtime: &AsyncRuntime,
    output: Arc<Mutex<Output>>,
    replies: Replies,
    sequence: Arc<AtomicU64>,
) -> Result<AsyncContext, String> {
    let context = AsyncContext::full(runtime)
        .await
        .map_err(|e| e.to_string())?;
    context.with(move |ctx| -> rquickjs::Result<()> {
        let log = output.clone();
        ctx.globals().set("__print", Function::new(ctx.clone(), move |ctx: Ctx<'_>, text: String| -> rquickjs::Result<()> {
            let mut log = log.lock().expect("JS 输出锁被污染");
            if text.len()+1 > FRAME_LIMIT.saturating_sub(log.bytes + 8192) || log.prints.len()>=4096 { return Err(Exception::throw_message(&ctx,"文字输出超过 1 MiB 或条目过多")); }
            let value = serde_json::from_str(&text).map_err(|_| Exception::throw_message(&ctx,"输出不是 JSON"))?;
            log.bytes += text.len()+1; log.prints.push(value); Ok(())
        })?)?;
        ctx.globals().set("__image", Function::new(ctx.clone(), move |ctx: Ctx<'_>, id: String| -> rquickjs::Result<()> {
            let mut log = output.lock().expect("JS 输出锁被污染");
            if id.len()>128 || log.images.len()>=8 { return Err(Exception::throw_message(&ctx,"图片引用或数量超限")); }
            log.images.push(id); Ok(())
        })?)?;
        ctx.globals().set("__rpc", Function::new(ctx.clone(), Async(move |request: String| {
            let replies = replies.clone(); let id = sequence.fetch_add(1,Ordering::Relaxed);
            async move {
                let value = serde_json::from_str(&request).map_err(|_|rquickjs::Error::Unknown)?;
                let (sender,receiver)=oneshot::channel();
                replies.lock().expect("JS 回复锁被污染").insert(id,sender);
                if write(&GuestOutput::Call {id,request:value}).is_err() {
                    replies.lock().expect("JS 回复锁被污染").remove(&id);
                    return Err(rquickjs::Error::Unknown);
                }
                receiver.await.map_err(|_|rquickjs::Error::Unknown)
            }
        }))?)?;
        ctx.eval::<(),_>(include_str!("sdk.js"))?;
        ctx.eval::<(),_>("for (const name of ['__rpc','__print','__image','__settle','browser','computer']) Object.defineProperty(globalThis,name,{writable:false,configurable:false});")?;
        Ok(())
    }).await.map_err(|e|e.to_string())?;
    Ok(context)
}

async fn evaluate(
    context: &AsyncContext,
    runtime: &AsyncRuntime,
    code: String,
) -> Result<(), String> {
    let result = context
        .async_with(async |ctx| match ctx.eval_promise(code) {
            Ok(promise) => promise
                .into_future::<Value>()
                .await
                .map(|_| ())
                .map_err(|e| exception(&ctx, e)),
            Err(error) => Err(exception(&ctx, error)),
        })
        .await;
    // 即使顶层抛错也要收取已启动 SDK 的结算，避免留下跨脚本输入。
    let settled = context
        .async_with(async |ctx| match ctx.eval_promise("await __settle()") {
            Ok(promise) => promise
                .into_future::<Value>()
                .await
                .map(|_| ())
                .map_err(|e| exception(&ctx, e)),
            Err(error) => Err(exception(&ctx, error)),
        })
        .await;
    while runtime.is_job_pending().await {
        runtime
            .execute_pending_job()
            .await
            .map_err(|e| e.to_string())?;
        tokio::task::yield_now().await;
    }
    result.and(settled)
}

async fn serve(mut commands: mpsc::Receiver<GuestInput>, replies: Replies) -> Result<(), String> {
    let runtime = AsyncRuntime::new().map_err(|e| e.to_string())?;
    runtime.set_memory_limit(64 * 1024 * 1024).await;
    runtime.set_max_stack_size(1024 * 1024).await;
    let output = Arc::new(Mutex::new(Output::default()));
    let sequence = Arc::new(AtomicU64::new(1));
    let mut ctx = context(&runtime, output.clone(), replies.clone(), sequence.clone()).await?;
    while let Some(command) = commands.recv().await {
        let (id, code, timeout) = match command {
            GuestInput::Run {
                id,
                code,
                timeout_ms,
            } if !code.is_empty() && code.len() <= 65536 && (1..=120000).contains(&timeout_ms) => {
                (id, Some(code), timeout_ms)
            }
            GuestInput::Run { id, .. } => {
                write(&GuestOutput::Finished(GuestFinished {
                    id,
                    prints: vec![],
                    images: vec![],
                    error: Some("代码或时间预算无效".into()),
                    reset: false,
                }))?;
                continue;
            }
            GuestInput::Reset { id } => (id, None, 1),
            GuestInput::Reply { .. } => return Err("回复不能进入命令队列".into()),
        };
        *output.lock().expect("JS 输出锁被污染") = Output::default();
        let interrupted = Arc::new(AtomicBool::new(false));
        let flag = interrupted.clone();
        let deadline = Instant::now() + Duration::from_millis(timeout);
        runtime
            .set_interrupt_handler(Some(Box::new(move || {
                let expired = Instant::now() >= deadline;
                if expired {
                    flag.store(true, Ordering::Release);
                }
                expired
            })))
            .await;
        let reset_requested = code.is_none();
        let error = if let Some(code) = code {
            match tokio::time::timeout(
                Duration::from_millis(timeout),
                evaluate(&ctx, &runtime, code),
            )
            .await
            {
                Ok(result) => result.err(),
                Err(_) => {
                    interrupted.store(true, Ordering::Release);
                    Some("JavaScript 执行超时".into())
                }
            }
        } else {
            None
        };
        let reset = reset_requested
            || interrupted.load(Ordering::Acquire)
            || error
                .as_ref()
                .is_some_and(|e| e.to_lowercase().contains("memory"));
        runtime.set_interrupt_handler(None).await;
        if reset {
            replies.lock().expect("JS 回复锁被污染").clear();
            drop(ctx);
            runtime.run_gc().await;
            ctx = context(&runtime, output.clone(), replies.clone(), sequence.clone()).await?;
        }
        let result = std::mem::take(&mut *output.lock().expect("JS 输出锁被污染"));
        write(&GuestOutput::Finished(GuestFinished {
            id,
            prints: result.prints,
            images: result.images,
            error,
            reset,
        }))?;
    }
    Ok(())
}

/// 在独立进程执行 JS 协议；仅允许宿主通过标准输入发送命令与 SDK 回执。
/// EOF 结束全部工作；协议格式、预算、I/O 或运行时初始化失败时返回错误。
pub fn run_guest() -> Result<(), String> {
    let replies: Replies = Default::default();
    let routing = replies.clone();
    let (sender, receiver) = mpsc::channel(4);
    std::thread::spawn(move || {
        let mut input = std::io::stdin().lock();
        loop {
            let mut line = Vec::new();
            let read = std::io::Read::take(&mut input, (FRAME_LIMIT + 1) as u64)
                .read_until(b'\n', &mut line);
            if !matches!(read,Ok(size) if size>0 && size<=FRAME_LIMIT) {
                break;
            }
            let Ok(frame) = serde_json::from_slice::<GuestInput>(&line) else {
                break;
            };
            match frame {
                GuestInput::Reply { id, value } => {
                    if let Some(sender) = routing.lock().expect("JS 回复锁被污染").remove(&id)
                    {
                        let _ = sender.send(value.to_string());
                    }
                }
                command => {
                    if sender.blocking_send(command).is_err() {
                        break;
                    }
                }
            }
        }
        routing.lock().expect("JS 回复锁被污染").clear();
    });
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?
        .block_on(serve(receiver, replies))
}
