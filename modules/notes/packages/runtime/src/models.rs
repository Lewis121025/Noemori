//! 模型安装属于用户请求，后续索引属于库生命周期；新搜索不能中止持久任务队列。

use crate::{Error, Result, Runtime};
use noemori_vault::{SearchCancellation, SemanticStatus};
use std::{path::PathBuf, sync::Arc};

impl Runtime {
    /// 安装固定模型后调度后台索引；返回当前覆盖状态，不等待全库推理完成。
    /// `source` 为空时下载，否则导入本地目录；`token` 只控制安装请求。
    /// # Errors
    /// 安装取消、模型校验失败、磁盘错误或库代次已变化。
    pub fn install_search_model(
        self: &Arc<Self>,
        source: Option<PathBuf>,
        token: SearchCancellation,
    ) -> impl std::future::Future<Output = Result<SemanticStatus>> + Send + 'static {
        let generation = self.generation();
        let pending = self.read(move |vault| vault.install_search_model(source.as_deref(), &token));
        let runtime = Arc::clone(self);
        async move {
            pending.wait().await??;
            runtime
                .write(true, move |state| {
                    if state.current_generation() != generation {
                        return Err(Error::State("笔记库已切换，请重新准备语义索引".into()));
                    }
                    state.schedule_publication();
                    Ok(state.vault()?.semantic_status()?)
                })
                .wait()
                .await?
        }
    }
}
