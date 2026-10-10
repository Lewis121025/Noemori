//! 先完整固定剪贴板字节，再暂存本次格式；只恢复仍由本次事务拥有的剪贴板。
use super::paste_lifecycle::PasteClipboard;
use objc2::{rc::Retained, runtime::ProtocolObject};
use objc2_app_kit::{NSPasteboard, NSPasteboardItem, NSPasteboardWriting};
use objc2_foundation::{NSArray, NSData, NSString};

const OWNER_TYPE: &str = "app.noemori.ui.clipboard-owner";
const MAXIMUM_BYTES: usize = 8 * 1024 * 1024;

/// 清空阶段只有版本所有权，格式写入完成后再增加标识核验，避免写入失败丢失原剪贴板。
enum Ownership {
    Cleared(isize),
    Installed(isize),
}

/// 原生粘贴同时提供纯文本；HTML 用 UTF-8 BOM 声明编码，纯文本与 RTF 保留调用者字节。
pub(crate) struct PasteContent<'a> {
    pub text: &'a str,
    pub html: Option<&'a str>,
    pub rtf: Option<&'a str>,
}

/// 所有格式均已材料化；读取失败或超预算时禁止先覆盖再尝试恢复。
pub(crate) struct ClipboardTransaction {
    board: Retained<NSPasteboard>,
    original: Vec<Retained<NSPasteboardItem>>,
    before: isize,
    owned: Option<Ownership>,
    token: String,
}

fn write(board: &NSPasteboard, items: &[Retained<NSPasteboardItem>]) -> Result<(), String> {
    if items.is_empty() {
        return Ok(());
    }
    let objects: Vec<&ProtocolObject<dyn NSPasteboardWriting>> = items
        .iter()
        .map(|item| ProtocolObject::from_ref(&**item))
        .collect();
    if !board.writeObjects(&NSArray::from_slice(&objects)) {
        return Err("系统剪贴板写入失败".into());
    }
    Ok(())
}

/// 只识别本运行时的专用格式；外部任意字节不得作为事务身份输出。
fn pending_owner(board: &NSPasteboard) -> Option<String> {
    let marker = NSString::from_str(OWNER_TYPE);
    board.availableTypeFromArray(&NSArray::from_slice(&[&*marker]))?;
    let token = board
        .dataForType(&marker)
        .filter(|data| data.length() == 36)
        .and_then(|data| String::from_utf8(data.to_vec()).ok())
        .and_then(|text| uuid::Uuid::parse_str(&text).ok())
        .map(|token| token.to_string());
    // 即便专用格式损坏，也必须保持排他；仅使用固定诊断标识，不回显外部内容。
    Some(token.unwrap_or_else(|| "unrecognized".into()))
}

/// 只读查询其他 Helper 正在持有的专用事务标识，不读取任何用户正文或其他格式。
pub(crate) fn shared_pending_token() -> Option<String> {
    pending_owner(&NSPasteboard::generalPasteboard())
}

impl ClipboardTransaction {
    /// 完整复制所有剪贴板项目与格式；本步骤只读，任何不可材料化格式均明确拒绝。
    pub(crate) fn prepare(board: Retained<NSPasteboard>) -> Result<Self, String> {
        let before = board.changeCount();
        if pending_owner(&board).is_some() {
            return Err("剪贴板已有尚未安全结算的 Noemori 事务，未覆盖或保存其临时内容".into());
        }
        let mut original = Vec::new();
        let mut bytes = 0usize;
        if let Some(items) = board.pasteboardItems() {
            if items.len() > 128 {
                return Err("剪贴板项目超过恢复预算".into());
            }
            for item in items {
                let copy = NSPasteboardItem::new();
                let types = item.types();
                if types.len() > 64 {
                    return Err("剪贴板格式超过恢复预算".into());
                }
                for format in types {
                    let data = item
                        .dataForType(&format)
                        .ok_or_else(|| format!("剪贴板格式 {format} 无法完整保存"))?;
                    bytes = bytes
                        .checked_add(data.length())
                        .ok_or("剪贴板字节预算溢出")?;
                    if bytes > MAXIMUM_BYTES {
                        return Err("剪贴板字节超过 8 MiB 恢复预算".into());
                    }
                    if !copy.setData_forType(&data, &format) {
                        return Err("剪贴板快照材料化失败".into());
                    }
                }
                original.push(copy);
            }
        } else if board.types().is_some_and(|types| !types.is_empty()) {
            return Err("剪贴板包含无法枚举的格式，不能保证恢复".into());
        }
        if board.changeCount() != before {
            return Err("保存期间用户剪贴板发生变化，未执行粘贴".into());
        }
        Ok(Self {
            board,
            original,
            before,
            owned: None,
            token: uuid::Uuid::new_v4().to_string(),
        })
    }

    /// 覆盖前重验版本并写入专用所有者标识；调用者须在此之前完成授权和取消检查。
    pub(crate) fn install(&mut self, content: PasteContent<'_>) -> Result<(), String> {
        self.install_using(content, write)
    }

    /// 写入原语允许独立命名剪贴板注入系统失败，验证覆盖后的恢复路径；生产入口固定使用 AppKit。
    pub(crate) fn install_using(
        &mut self,
        content: PasteContent<'_>,
        writer: impl FnOnce(&NSPasteboard, &[Retained<NSPasteboardItem>]) -> Result<(), String>,
    ) -> Result<(), String> {
        let item = NSPasteboardItem::new();
        for (format, value) in [
            ("public.utf8-plain-text", Some(content.text)),
            ("public.html", content.html),
            ("public.rtf", content.rtf),
            (OWNER_TYPE, Some(self.token.as_str())),
        ] {
            let Some(value) = value else { continue };
            let mut bytes = Vec::new();
            // public.html 默认编码由消费者猜测；BOM 自描述 Unicode 字符串的 UTF-8 字节，不改写用户标记。
            if format == "public.html" && !value.starts_with('\u{feff}') {
                bytes.extend_from_slice(b"\xef\xbb\xbf");
            }
            bytes.extend_from_slice(value.as_bytes());
            if !item.setData_forType(&NSData::from_vec(bytes), &NSString::from_str(format)) {
                return Err("粘贴格式无法写入剪贴板项目".into());
            }
        }
        if self.board.changeCount() != self.before {
            return Err("用户剪贴板已经变化，未执行粘贴".into());
        }
        self.owned = Some(Ownership::Cleared(self.board.clearContents()));
        let result = writer(&self.board, &[item]);
        if result.is_ok() {
            let revision = self.board.changeCount();
            if !self.marker_matches() {
                return Err("剪贴板被其他程序修改，未发送粘贴按键".into());
            }
            self.owned = Some(Ownership::Installed(revision));
        }
        result
    }

    fn marker_matches(&self) -> bool {
        self.board
            .dataForType(&NSString::from_str(OWNER_TYPE))
            .is_some_and(|data| data.to_vec() == self.token.as_bytes())
    }

    /// 派发键盘前同时核验 changeCount 与所有者标识，避免读取其他程序刚写入的内容。
    pub(crate) fn require_owned(&self) -> Result<(), String> {
        if matches!(self.owned, Some(Ownership::Installed(revision)) if revision == self.board.changeCount())
            && self.marker_matches()
        {
            Ok(())
        } else {
            Err("剪贴板不再属于本次粘贴，输入已暂停".into())
        }
    }

    /// 取消同样执行清理；用户写入新内容时返回 false 并保留其内容，系统写入失败返回错误。
    pub(crate) fn restore(&mut self) -> Result<bool, String> {
        if self.owned.is_none() {
            return Ok(true);
        }
        if !self.owns_current() {
            self.owned = None;
            return Ok(false);
        }
        self.owned = Some(Ownership::Cleared(self.board.clearContents()));
        write(&self.board, &self.original)?;
        self.owned = None;
        Ok(true)
    }
    fn owns_current(&self) -> bool {
        match self.owned {
            Some(Ownership::Cleared(revision)) => revision == self.board.changeCount(),
            Some(Ownership::Installed(revision)) => {
                revision == self.board.changeCount() && self.marker_matches()
            }
            None => false,
        }
    }
}
impl PasteClipboard for ClipboardTransaction {
    fn owned(&self) -> bool {
        self.owns_current()
    }
    fn restore(&mut self) -> Result<bool, String> {
        ClipboardTransaction::restore(self)
    }
}
