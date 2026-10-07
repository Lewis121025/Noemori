use super::state::State;
use crate::tool::terminal::{TerminalEvent, TerminalInfo, TerminalObserver, TerminalSubscription};
use std::sync::Weak;

/// 独立日志读者只发布游标变化；界面读取正文时不会影响模型增量结果。
pub(super) struct Observer(pub(super) Weak<State>);
impl TerminalObserver for Observer {
    fn started(&self, call_id: &str, info: TerminalInfo, mut output: TerminalSubscription) {
        let Some(state) = self.0.upgrade() else {
            return;
        };
        let (retention, error) = match output.fork(0) {
            Ok(retention) => (Some(retention), None),
            Err(error) => (None, Some(error)),
        };
        let id = info.session_id.clone();
        state.terminal_started(call_id.into(), info, retention, error);
        state.tasks.clone().spawn(async move {
            loop {
                match output.recv().await {
                    Ok(Some(TerminalEvent::Output { chunk, .. })) => {
                        state.terminal_output(&id, chunk.next_offset)
                    }
                    Ok(Some(TerminalEvent::Exited { process })) => {
                        state.terminal_finished(process);
                        break;
                    }
                    Ok(None) => break,
                    Err(error) => {
                        if let Some(process) = output.final_info() {
                            state.terminal_finished(process);
                        }
                        state.terminal_error(&id, error);
                        break;
                    }
                }
            }
        });
    }
}
