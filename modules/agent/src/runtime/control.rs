use crate::{Error, Message, Role};
use std::sync::{Arc, Mutex};

struct Inputs {
    accepting: bool,
    texts: Vec<String>,
}

/// 同轮补充文字的接收边界；结束检查和接收使用同一把锁，避免成功回执之后丢失输入。
#[derive(Clone)]
pub(crate) struct RunControl(Arc<Mutex<Inputs>>);

impl RunControl {
    pub(crate) fn new() -> Self {
        Self(Arc::new(Mutex::new(Inputs {
            accepting: true,
            texts: Vec::new(),
        })))
    }

    /// 只缓存下一次模型请求使用的用户文字，不中断当前工具或替换正在执行的模型。
    pub(crate) fn push(&self, text: String) -> Result<(), Error> {
        if text.trim().is_empty() || text.len() > 128 * 1024 {
            return Err(Error::Config("补充指令必须非空且不超过 128 KiB".into()));
        }
        let mut inputs = self.0.lock().expect("补充指令锁被污染");
        if !inputs.accepting {
            return Err(Error::Config("当前运行正在结束，补充指令未接收".into()));
        }
        if inputs.texts.len() >= 16 {
            return Err(Error::Config(
                "待处理补充指令过多，请等待当前任务推进".into(),
            ));
        }
        inputs.texts.push(text);
        Ok(())
    }

    pub(crate) fn drain(&self) -> Vec<Message> {
        let mut inputs = self.0.lock().expect("补充指令锁被污染");
        std::mem::take(&mut inputs.texts)
            .into_iter()
            .map(|text| Message::text(Role::User, text))
            .collect()
    }

    /// 已接受的补充尚未读取时不能宣告完成；空队列时原子关闭接收。
    pub(crate) fn complete_if_empty(&self) -> bool {
        let mut inputs = self.0.lock().expect("补充指令锁被污染");
        if !inputs.texts.is_empty() {
            return false;
        }
        inputs.accepting = false;
        true
    }

    /// 取消、超时和异常终态也把已确认的输入并入历史，下一次继续不会遗漏。
    pub(crate) fn finish(&self) -> Vec<Message> {
        let mut inputs = self.0.lock().expect("补充指令锁被污染");
        inputs.accepting = false;
        std::mem::take(&mut inputs.texts)
            .into_iter()
            .map(|text| Message::text(Role::User, text))
            .collect()
    }
}
