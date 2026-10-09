use crate::{Error, Message, Role, validate_history};
use std::sync::{Arc, Mutex};

struct Inputs {
    accepting: bool,
    messages: Vec<Message>,
}

/// 同轮补充文字的接收边界；结束检查和接收使用同一把锁，避免成功回执之后丢失输入。
#[derive(Clone)]
pub(crate) struct RunControl(Arc<Mutex<Inputs>>);

impl RunControl {
    pub(crate) fn new() -> Self {
        Self(Arc::new(Mutex::new(Inputs {
            accepting: true,
            messages: Vec::new(),
        })))
    }

    /// 用户正文与媒体一起冻结，不中断当前工具或替换正在执行的模型。
    pub(crate) fn push(&self, message: Message) -> Result<(), Error> {
        let text = message.text_content();
        if message.role != Role::User
            || message.provider_data.is_some()
            || text.trim().is_empty()
            || text.len() > 128 * 1024
        {
            return Err(Error::Config("补充指令必须非空且不超过 128 KiB".into()));
        }
        validate_history(std::slice::from_ref(&message))?;
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

    pub(crate) fn drain(&self) -> Vec<Message> {
        let mut inputs = self.0.lock().expect("补充指令锁被污染");
        std::mem::take(&mut inputs.messages)
    }

    /// 已接受的补充尚未读取时不能宣告完成；空队列时原子关闭接收。
    pub(crate) fn complete_if_empty(&self) -> bool {
        let mut inputs = self.0.lock().expect("补充指令锁被污染");
        if !inputs.messages.is_empty() {
            return false;
        }
        inputs.accepting = false;
        true
    }

    /// 取消、超时和异常终态也把已确认的输入并入历史，下一次继续不会遗漏。
    pub(crate) fn finish(&self) -> Vec<Message> {
        let mut inputs = self.0.lock().expect("补充指令锁被污染");
        inputs.accepting = false;
        std::mem::take(&mut inputs.messages)
    }
}
