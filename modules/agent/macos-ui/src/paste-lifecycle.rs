//! 已投递的粘贴不能回滚：只读确认实际消费后，才安全结束剪贴板事务。

/// 目标查询绑定原应用实例；无法读取文本时继续保留材料，不推断输入尚未发生。
pub(crate) trait PasteTarget {
    /// 原实例是否仍可能消费已经排队的输入。
    fn alive(&self) -> bool;
    /// 读取原文本控件；错误必须保留为等待原因。
    fn text(&self) -> Result<String, String>;
}

/// 剪贴板所有权同时保护版本与本事务标识；恢复失败不得丢弃材料或恢复状态。
pub(crate) trait PasteClipboard {
    /// 用户或其他程序覆盖后为 false，不允许恢复旧材料。
    fn owned(&self) -> bool;
    /// 只在仍拥有当前内容时恢复；失败保留事务，false 表示用户已接管。
    fn restore(&mut self) -> Result<bool, String>;
}

/// 安全结算条件只包括消费确认、原实例终止和新剪贴板所有者接管。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SettlementReason {
    Acknowledged,
    TargetExited,
    OwnershipLost,
    NotDispatched,
}
impl SettlementReason {
    /// 返回稳定的证据名称，不能把实例终止或所有权丢失当作动作未执行。
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Acknowledged => "acknowledged",
            Self::TargetExited => "target_exited",
            Self::OwnershipLost => "ownership_lost",
            Self::NotDispatched => "not_dispatched",
        }
    }
}

/// 只说明真实消费与剪贴板清理证据，业务结果仍需根据目标应用检查。
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct PasteSettlement {
    /// 关联原 unknown 回执，不能用另一个事务的结算代替。
    pub token: String,
    /// 当前安全结束条件，不等同于是否已消费。
    pub reason: SettlementReason,
    /// false 表示用户或其他应用已接管剪贴板，保留其新内容。
    pub clipboard_restored: bool,
    /// 已派发后发生的取消、释放或焦点变化。
    pub interrupted: Option<String>,
    /// 消费确认是持久事实，后续用户编辑或剪贴板覆盖不会撤销。
    pub acknowledged: bool,
    /// 最近读取或恢复失败的诊断，恢复成功后仍保留事实。
    pub error: Option<String>,
}

/// 一个已派发动作拥有一份原剪贴板；释放或断连仅进入只读排空，不能清空此状态。
pub(crate) struct PendingPaste<T: PasteTarget, C: PasteClipboard> {
    target: T,
    clipboard: C,
    expected: Option<String>,
    token: String,
    interrupted: Option<String>,
    error: Option<String>,
    session: String,
    safe_reason: Option<SettlementReason>,
}
impl<T: PasteTarget, C: PasteClipboard> PendingPaste<T, C> {
    /// 仅在至少一条粘贴键事件已经派发后创建；expected 是当前选区替换后的完整文本。
    pub(crate) fn new(
        target: T,
        clipboard: C,
        expected: String,
        token: String,
        session: String,
    ) -> Self {
        Self {
            target,
            clipboard,
            expected: Some(expected),
            token,
            interrupted: None,
            error: None,
            session,
            safe_reason: None,
        }
    }
    /// 按键尚未派发但原材料恢复失败；允许只重试清理，不能补发粘贴键。
    pub(crate) fn recovery(
        target: T,
        clipboard: C,
        token: String,
        session: String,
        error: String,
    ) -> Self {
        Self {
            target,
            clipboard,
            expected: None,
            token,
            interrupted: Some(error.clone()),
            error: Some(error),
            session,
            safe_reason: Some(SettlementReason::NotDispatched),
        }
    }
    /// 中断只记录事实，不能使已排队键盘事件失去它应消费的剪贴板。
    pub(crate) fn interrupted(&mut self, reason: String) {
        if self.interrupted.is_none() {
            self.interrupted = Some(reason);
        }
    }
    /// 提供有界等待结束后的可查询身份，不暴露原剪贴板内容。
    pub(crate) fn token(&self) -> &str {
        &self.token
    }
    /// 返回事务的可信会话归属，其他会话的释放不能改变此事务事实。
    pub(crate) fn session(&self) -> &str {
        &self.session
    }
    /// 提供最近只读或恢复错误，不能静默吞掉应用无响应或系统恢复失败。
    pub(crate) fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }

    /// 不派发任何输入；只有三种安全条件成立才恢复或保留用户的新剪贴板。
    /// 未结算返回 None，恢复失败返回错误并保留全部材料，成功返回真实清理证据。
    pub(crate) fn poll(&mut self) -> Result<Option<PasteSettlement>, String> {
        let reason = if !self.clipboard.owned() {
            Some(SettlementReason::OwnershipLost)
        } else if self.safe_reason.is_some() {
            self.safe_reason
        } else if self.expected.is_none() {
            Some(SettlementReason::NotDispatched)
        } else if !self.target.alive() {
            Some(SettlementReason::TargetExited)
        } else {
            match self.target.text() {
                Ok(value) if self.expected.as_ref() == Some(&value) => {
                    Some(SettlementReason::Acknowledged)
                }
                Ok(_) => None,
                Err(error) => {
                    self.error = Some(error);
                    None
                }
            }
        };
        let Some(reason) = reason else {
            return Ok(None);
        };
        if reason != SettlementReason::OwnershipLost {
            self.safe_reason = Some(reason);
        }
        let clipboard_restored = if reason == SettlementReason::OwnershipLost {
            false
        } else {
            match self.clipboard.restore() {
                Ok(restored) => restored,
                Err(error) => {
                    self.error = Some(error.clone());
                    return Err(error);
                }
            }
        };
        Ok(Some(PasteSettlement {
            token: self.token.clone(),
            reason,
            clipboard_restored,
            interrupted: self.interrupted.clone(),
            acknowledged: self.safe_reason == Some(SettlementReason::Acknowledged),
            error: self.error.clone(),
        }))
    }
}
