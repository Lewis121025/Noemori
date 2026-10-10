use crate::{Error, Message, Role, validate_history};
use std::sync::{Arc, Mutex};
use tokio::sync::Notify;

struct Inputs {
    accepting: bool,
    messages: Vec<Message>,
    pause_requested: bool,
    paused: bool,
    execution: Option<crate::CancellationToken>,
}

/// 同轮补充文字的接收边界；结束检查和接收使用同一把锁，避免成功回执之后丢失输入。
#[derive(Clone)]
pub(crate) struct RunControl(Arc<Mutex<Inputs>>, Arc<Notify>);

impl RunControl {
    /// 恢复已接受的补充队列；校验每条真实输入，队列上限只限制新的接收操作。
    /// 输入非法时拒绝构造，避免恢复后才发现无法提交给模型。
    pub(crate) fn with_inputs(messages: Vec<Message>) -> Result<Self, Error> {
        for message in &messages {
            Self::validate_input(message)?;
        }
        Ok(Self(
            Arc::new(Mutex::new(Inputs {
                accepting: true,
                messages,
                pause_requested: false,
                paused: false,
                execution: None,
            })),
            Arc::new(Notify::new()),
        ))
    }

    /// 接管只中断当前模型或工具节点，整轮取消信号与已闭合历史保持原有归属。
    pub(crate) fn pause(&self) {
        let mut inputs = self.0.lock().expect("运行控制锁被污染");
        if !inputs.accepting {
            return;
        }
        inputs.pause_requested = true;
        if let Some(execution) = &inputs.execution {
            execution.cancel();
        }
        self.1.notify_waiters();
    }

    pub(crate) fn pause_requested(&self) -> bool {
        self.0.lock().expect("运行控制锁被污染").pause_requested
    }
    pub(crate) fn is_paused(&self) -> bool {
        self.0.lock().expect("运行控制锁被污染").paused
    }

    /// 每个模型与工具节点使用独立子取消信号；接管不能误取消后续恢复的运行。
    pub(crate) fn execution(&self, parent: &crate::CancellationToken) -> crate::CancellationToken {
        let token = parent.child_token();
        let mut inputs = self.0.lock().expect("运行控制锁被污染");
        if inputs.pause_requested {
            token.cancel();
        }
        inputs.execution = Some(token.clone());
        token
    }

    pub(crate) fn mark_paused(&self) {
        let mut inputs = self.0.lock().expect("运行控制锁被污染");
        inputs.paused = inputs.pause_requested;
        inputs.execution = None;
        self.1.notify_waiters();
    }

    /// 接管回执只在当前节点已结算并进入等待后完成；结束或取消不会留下悬挂等待。
    pub(crate) async fn wait_paused(&self, context: &crate::ExecutionContext) -> Result<(), Error> {
        loop {
            let changed = self.1.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            {
                let inputs = self.0.lock().expect("运行控制锁被污染");
                if inputs.paused || !inputs.accepting {
                    return Ok(());
                }
            }
            context.wait(changed).await?;
        }
    }

    pub(crate) fn resume(&self) {
        let mut inputs = self.0.lock().expect("运行控制锁被污染");
        inputs.pause_requested = false;
        inputs.paused = false;
        self.1.notify_waiters();
    }

    /// 等待用户时不消耗运行时间预算；显式取消仍立即终止，并保留先前调用次数。
    pub(crate) async fn wait_resume(
        &self,
        context: &mut crate::ExecutionContext,
    ) -> Result<(), Error> {
        let started = tokio::time::Instant::now();
        loop {
            let changed = self.1.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if !self.pause_requested() {
                break;
            }
            tokio::select! {
                biased;
                () = context.cancellation.cancelled() => return Err(Error::Cancelled),
                () = changed => {}
            }
        }
        context.deadline = context
            .deadline
            .checked_add(started.elapsed())
            .ok_or_else(|| Error::Config("恢复后的运行期限不可表示".into()))?;
        context.check()
    }

    /// 用户正文与媒体一起冻结，不中断当前工具或替换正在执行的模型。
    pub(crate) fn push(&self, message: Message) -> Result<(), Error> {
        Self::validate_input(&message)?;
        let mut inputs = self.0.lock().expect("补充指令锁被污染");
        if !inputs.accepting {
            return Err(Error::Config("当前运行正在结束，补充指令未接收".into()));
        }
        if inputs.messages.len() >= 16 {
            return Err(Error::Config(
                "待处理补充指令过多，请等待当前任务推进".into(),
            ));
        }
        inputs.messages.push(message);
        Ok(())
    }

    /// 恢复和实时接收共享输入契约；不接受助手内容或供应商私有载荷作为补充。
    pub(crate) fn validate_input(message: &Message) -> Result<(), Error> {
        let text = message.text_content();
        if message.role != Role::User
            || message.provider_data.is_some()
            || text.trim().is_empty()
            || text.len() > 128 * 1024
        {
            return Err(Error::Config("补充指令必须非空且不超过 128 KiB".into()));
        }
        validate_history(std::slice::from_ref(message))
    }

    pub(crate) fn drain(&self) -> Vec<Message> {
        let mut inputs = self.0.lock().expect("补充指令锁被污染");
        std::mem::take(&mut inputs.messages)
    }

    /// 已接受的补充尚未读取时不能宣告完成；空队列时原子关闭接收。
    pub(crate) fn complete_if_empty(&self) -> bool {
        let mut inputs = self.0.lock().expect("补充指令锁被污染");
        if inputs.pause_requested || !inputs.messages.is_empty() {
            return false;
        }
        inputs.accepting = false;
        true
    }

    /// 终态关闭接收并交付未消费输入；保持历史顺序，由后续运行恢复队列。
    pub(crate) fn finish(&self) -> Vec<Message> {
        let mut inputs = self.0.lock().expect("补充指令锁被污染");
        inputs.accepting = false;
        inputs.pause_requested = false;
        inputs.paused = false;
        self.1.notify_waiters();
        std::mem::take(&mut inputs.messages)
    }
}
