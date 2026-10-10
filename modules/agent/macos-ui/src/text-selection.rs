//! 文本定位采用 Unicode 字符边界匹配，再转换为 AX 要求的 UTF-16 范围。

/// 输出范围遵循 AX 的 UTF-16 契约，不能用 UTF-8 字节或 Unicode 字符序号代替。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct TextRange {
    pub location: usize,
    pub length: usize,
}

/// 对唯一文字设置选区或前后光标；前后文只参与消歧，不扩大选区。
#[derive(Clone, Copy, Debug)]
pub(crate) struct TextSelection<'a> {
    pub text: &'a str,
    pub prefix: Option<&'a str>,
    pub suffix: Option<&'a str>,
    pub position: &'a str,
}

/// 在当前完整控件文字中定位唯一匹配；空文本、歧义、未找到或无效位置均返回错误。
pub(crate) fn locate(value: &str, selection: TextSelection<'_>) -> Result<TextRange, String> {
    if selection.text.is_empty() {
        return Err("选区目标文字不能为空".into());
    }
    if !matches!(selection.position, "select" | "before" | "after") {
        return Err("选区位置必须为 select、before 或 after".into());
    }
    let mut found = None;
    // char_indices 保留重叠匹配并排除 UTF-8 字符内部位置，避免静默选择第一个。
    for (start, _) in value.char_indices() {
        if !value[start..].starts_with(selection.text) {
            continue;
        }
        let end = start + selection.text.len();
        if selection
            .prefix
            .is_some_and(|prefix| !value[..start].ends_with(prefix))
            || selection
                .suffix
                .is_some_and(|suffix| !value[end..].starts_with(suffix))
        {
            continue;
        }
        if found.is_some() {
            return Err("文字匹配不唯一，请提供 prefix 或 suffix 消歧".into());
        }
        found = Some((start, end));
    }
    let (start, end) = found.ok_or("没有找到符合前后文的目标文字")?;
    let location = value[..if selection.position == "after" {
        end
    } else {
        start
    }]
        .encode_utf16()
        .count();
    Ok(TextRange {
        location,
        length: if selection.position == "select" {
            selection.text.encode_utf16().count()
        } else {
            0
        },
    })
}

/// 将 AX UTF-16 范围转换成 Rust 字节边界；越界或切开代理对均拒绝。
pub(crate) fn byte_range(value: &str, range: TextRange) -> Result<std::ops::Range<usize>, String> {
    let end = range
        .location
        .checked_add(range.length)
        .ok_or("文本范围溢出")?;
    let mut utf16 = 0;
    let mut start_byte = None;
    let mut end_byte = None;
    for (byte, character) in value
        .char_indices()
        .chain(std::iter::once((value.len(), '\0')))
    {
        if utf16 == range.location {
            start_byte = Some(byte);
        }
        if utf16 == end {
            end_byte = Some(byte);
        }
        if byte == value.len() {
            break;
        }
        utf16 += character.len_utf16();
    }
    match (start_byte, end_byte) {
        (Some(start), Some(end)) => Ok(start..end),
        _ => Err("AX 文本范围越界或切开 Unicode 字符".into()),
    }
}
