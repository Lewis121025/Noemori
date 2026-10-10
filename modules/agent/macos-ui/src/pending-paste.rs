//! 原生消费探针保留原 AX 对象和原应用实例，不对相似文本或复用 PID 重新绑定。
use super::{
    ax::Element,
    clipboard::ClipboardTransaction,
    paste_lifecycle::{PasteTarget, PendingPaste},
};
use objc2::rc::Retained;
use objc2_app_kit::NSRunningApplication;

/// 原生事务直接持有原材料；服务排空期间只读取此目标，不再次发送输入。
pub(crate) type NativePendingPaste = PendingPaste<NativePasteTarget, ClipboardTransaction>;

/// 保留的应用实例终止后才确认不可能再消费旧输入，PID 复用不能延长旧事务。
pub(crate) struct NativePasteTarget {
    /// 原授权控件的真实对象，不能重新搜索相似节点。
    pub(crate) element: Element,
    /// 原启动实例的保留对象，终止不能按同 PID 的新实例重新解释。
    pub(crate) app: Retained<NSRunningApplication>,
    fingerprint: String,
}
/// 同步调用在五秒内完成或移交唯一事务给服务轮询，不通过 Drop 恢复剪贴板。
pub(crate) enum TextInteraction {
    Completed(serde_json::Value),
    Settled(super::paste_lifecycle::PasteSettlement),
    Pending(NativePendingPaste),
}
impl NativePasteTarget {
    /// element 与 app 来自同一次已授权的实际窗口和控件解析。
    pub(crate) fn new(
        element: Element,
        app: Retained<NSRunningApplication>,
        fingerprint: String,
    ) -> Self {
        Self {
            element,
            app,
            fingerprint,
        }
    }
}
impl PasteTarget for NativePasteTarget {
    fn alive(&self) -> bool {
        !self.app.isTerminated()
    }
    fn text(&self) -> Result<String, String> {
        if self.element.fingerprint()? != self.fingerprint {
            return Err("已投递粘贴的原控件语义已变化，继续等待安全清理".into());
        }
        self.element.editable_text()
    }
}
