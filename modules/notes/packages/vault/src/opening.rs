//! 开库准备阶段的真实进度与协作取消；回调只在调用线程执行。

use crate::Error;

/// 打开过程的阶段；每阶段独立计数，不把阶段序号伪装成总体百分比。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenPhase {
    /// 恢复上次中断的文件事务并打开派生库。
    Recovering,
    /// 枚举磁盘目录，发现总量前保持不确定进度。
    Scanning,
    /// 对照已知文件清单核对磁盘元数据。
    Checking,
    /// 读取变化文件并解析正文与链接。
    Reading,
    /// 提交同版本的链接、属性和正文索引。
    Indexing,
    /// 同步全文排名索引。
    Ranking,
}

/// 一个阶段的可观测工作量；总数未知时只报告已处理数量。
#[derive(Debug, Clone, Copy)]
pub struct OpenProgress {
    /// 正在进行的阶段。
    pub phase: OpenPhase,
    /// 已完成条目数。
    pub completed: usize,
    /// 已确定的总数；枚举及不可拆分事务为 `None`。
    pub total: Option<usize>,
}

/// 同步进度观察器；返回 false 请求在安全边界取消，错误保留原原因。
pub type OpenObserver<'a> = dyn FnMut(OpenProgress) -> Result<bool, Error> + 'a;

pub(crate) fn report(
    observer: &mut OpenObserver<'_>,
    phase: OpenPhase,
    completed: usize,
    total: Option<usize>,
) -> Result<(), Error> {
    if observer(OpenProgress {
        phase,
        completed,
        total,
    })? {
        Ok(())
    } else {
        Err(Error::OpenCancelled)
    }
}

/// 为底层 IO 保留出错文件身份，权限、删除与目录问题不能变成无路径的错误。
pub(crate) fn access(path: impl AsRef<std::path::Path>, source: std::io::Error) -> Error {
    Error::FileAccess {
        path: path.as_ref().to_path_buf(),
        source,
    }
}
