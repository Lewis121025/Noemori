//! AX 的受审计边界；Copy 结果按拥有规则回收，CF 类型转换先核验动态类型。
use objc2_application_services::{AXError, AXIsProcessTrusted, AXUIElement, AXValue, AXValueType};
use objc2_core_foundation::{
    CFArray, CFBoolean, CFNumber, CFRetained, CFString, CFType, CGPoint, CGSize, Type,
};
use serde_json::{Value, json};
use std::{ptr::NonNull, time::Instant};

/// 保留真实 AX 对象，编号和相似名称不能替代对象身份。
#[derive(Clone)]
pub(crate) struct Element(CFRetained<AXUIElement>);
pub(crate) use super::geometry::Bounds;

#[derive(Debug)]
struct AttributeError {
    name: String,
    code: Option<AXError>,
    detail: String,
}
impl From<AttributeError> for String {
    fn from(error: AttributeError) -> Self {
        format!("{}：{}", error.name, error.detail)
    }
}
impl AttributeError {
    fn absent(&self) -> bool {
        matches!(
            self.code,
            Some(AXError::AttributeUnsupported | AXError::NoValue)
        )
    }
}
/// 只查询当前进程的辅助功能授权，不弹出授权请求。
pub(crate) fn trusted() -> bool {
    // SAFETY: 只查询当前进程，不请求自动授权。
    unsafe { AXIsProcessTrusted() }
}
/// 根据系统提供的正 PID 创建保留对象并设置 AX 超时；无效 PID 或系统拒绝时返回诊断。
pub(crate) fn application(pid: i32) -> Result<Element, String> {
    if pid <= 0 {
        return Err("应用 PID 无效".into());
    }
    // SAFETY: PID 来自 NSRunningApplication，返回对象由 CFRetained 拥有。
    let element = unsafe { AXUIElement::new_application(pid) };
    // SAFETY: 保留对象有效，超时为有限正数。
    check(unsafe { element.set_messaging_timeout(0.1) })?;
    Ok(Element(element))
}
fn check(error: AXError) -> Result<(), String> {
    if error == AXError::Success {
        Ok(())
    } else {
        Err(format!("AX 调用失败：{}", error.0))
    }
}
// AX 的数组元素由系统保证为 CF 对象；这里只放宽到 CFType，再逐个核验具体类型。
fn typed_array(value: &CFType) -> Result<CFRetained<CFArray<CFType>>, String> {
    let array = value
        .downcast_ref::<CFArray>()
        .ok_or("AX 数组不是 CFArray")?;
    // SAFETY: 已检查 CFArray 动态类型，AX API 保证内部为有效 CFType；未转换为具体控件或字符串。
    Ok(unsafe { CFRetained::cast_unchecked::<CFArray<CFType>>(array.retain()) })
}
impl Element {
    /// 比较实际 AX 对象身份，不用标题或节点位置替代身份。
    pub(crate) fn same(&self, other: &Self) -> bool {
        self.0 == other.0
    }
    fn attribute(&self, name: &str) -> Result<CFRetained<CFType>, AttributeError> {
        let mut pointer = std::ptr::null();
        let attribute = CFString::from_str(name);
        // SAFETY: 输出地址存活到同步调用结束，成功 Copy 返回拥有的 CFType。
        let status = unsafe {
            self.0
                .copy_attribute_value(&attribute, NonNull::from(&mut pointer))
        };
        if status != AXError::Success {
            return Err(AttributeError {
                name: name.into(),
                code: Some(status),
                detail: match status {
                    AXError::AttributeUnsupported => "属性不支持".into(),
                    AXError::NoValue => "属性无值".into(),
                    AXError::CannotComplete => "应用未在 AX 超时内响应".into(),
                    _ => format!("AX 错误 {}", status.0),
                },
            });
        }
        let pointer = NonNull::new(pointer.cast_mut()).ok_or_else(|| AttributeError {
            name: name.into(),
            code: None,
            detail: "成功回执包含空属性".into(),
        })?;
        // SAFETY: 成功 Copy 已将引用所有权交给调用方。
        Ok(unsafe { CFRetained::from_raw(pointer) })
    }
    /// 读取有界字符串属性；缺失、应用超时或 CF 类型不符时返回明确错误。
    pub(crate) fn text(&self, name: &str) -> Result<String, String> {
        let value = self.attribute(name)?;
        value
            .downcast_ref::<CFString>()
            .map(|string| string.to_string().chars().take(1024).collect())
            .ok_or_else(|| format!("{name} 不是字符串"))
    }
    /// 可选属性仅将系统声明的“不支持／无值”映射为空；超时和类型错误不能被隐藏。
    pub(crate) fn optional_text(&self, name: &str) -> Result<Option<String>, String> {
        match self.attribute(name) {
            Ok(value) => value
                .downcast_ref::<CFString>()
                .map(|value| Some(value.to_string().chars().take(1024).collect()))
                .ok_or_else(|| format!("{name} 不是字符串")),
            Err(error) if error.absent() => Ok(None),
            Err(error) => Err(error.into()),
        }
    }
    fn optional_element(&self, name: &str) -> Result<Option<Element>, String> {
        match self.attribute(name) {
            Ok(value) => value
                .downcast_ref::<AXUIElement>()
                .map(|value| Some(Element(value.retain())))
                .ok_or_else(|| format!("{name} 不是 AX 元素")),
            Err(error) if error.absent() => Ok(None),
            Err(error) => Err(error.into()),
        }
    }
    /// 读取并保留单个 AX 元素属性；类型不符或读取失败时不制造空句柄。
    pub(crate) fn element(&self, name: &str) -> Result<Element, String> {
        let value = self.attribute(name)?;
        value
            .downcast_ref::<AXUIElement>()
            .map(|element| Element(element.retain()))
            .ok_or_else(|| format!("{name} 不是 AX 元素"))
    }
    fn children(&self) -> Result<Vec<Element>, AttributeError> {
        let value = self.attribute("AXChildren")?;
        let array = typed_array(&value).map_err(|detail| AttributeError {
            name: "AXChildren".into(),
            code: None,
            detail,
        })?;
        array
            .iter()
            .take(128)
            .map(|value| {
                value
                    .downcast_ref::<AXUIElement>()
                    .map(|element| Element(element.retain()))
                    .ok_or_else(|| AttributeError {
                        name: "AXChildren".into(),
                        code: None,
                        detail: "子节点不是 AX 元素".into(),
                    })
            })
            .collect()
    }
    /// 按 limit 限制复制的元素数量，逐一核验 CF 类型；失败返回原始 AX 诊断。
    pub(crate) fn elements(&self, name: &str, limit: usize) -> Result<Vec<Element>, String> {
        let mut pointer = std::ptr::null();
        // SAFETY: 输出地址有效且数量有界；成功 Copy 返回拥有的数组。
        check(unsafe {
            self.0.copy_attribute_values(
                &CFString::from_str(name),
                0,
                limit as isize,
                NonNull::from(&mut pointer),
            )
        })?;
        let pointer = NonNull::new(pointer.cast_mut()).ok_or("AX 返回空数组")?;
        // SAFETY: 成功 Copy 返回拥有引用，先统一为 CFType 再检查实际数组类型。
        let value = unsafe { CFRetained::<CFType>::from_raw(pointer.cast()) };
        let array = typed_array(&value)?;
        array
            .iter()
            .take(limit)
            .map(|value| {
                value
                    .downcast_ref::<AXUIElement>()
                    .map(|element| Element(element.retain()))
                    .ok_or_else(|| "AX 子节点类型无效".into())
            })
            .collect()
    }
    /// 动作前重新读取屏幕点范围；缺失、类型错误和非有限坐标都拒绝，避免使用旧截图定位。
    pub(crate) fn bounds(&self) -> Result<Bounds, String> {
        let position = self.attribute("AXPosition")?;
        let size = self.attribute("AXSize")?;
        let position = position
            .downcast_ref::<AXValue>()
            .ok_or("AXPosition 类型无效")?;
        let size = size.downcast_ref::<AXValue>().ok_or("AXSize 类型无效")?;
        let mut point = CGPoint::ZERO;
        let mut dimensions = CGSize::ZERO;
        // SAFETY: CF 和 AXValue 结构类型均已核验，输出结构布局匹配。
        unsafe {
            if position.r#type() != AXValueType::CGPoint
                || size.r#type() != AXValueType::CGSize
                || !position.value(AXValueType::CGPoint, NonNull::from(&mut point).cast())
                || !size.value(AXValueType::CGSize, NonNull::from(&mut dimensions).cast())
            {
                return Err("AX 几何属性无效".into());
            }
        }
        let bounds = Bounds {
            x: point.x,
            y: point.y,
            width: dimensions.width,
            height: dimensions.height,
        };
        if ![bounds.x, bounds.y, bounds.width, bounds.height]
            .iter()
            .all(|value| value.is_finite())
            || bounds.width < 0.0
            || bounds.height < 0.0
        {
            return Err("AX 范围无效".into());
        }
        Ok(bounds)
    }
    /// 读取当前对象实际支持的动作；不根据角色猜测可执行能力。
    pub(crate) fn actions(&self) -> Result<Vec<String>, String> {
        let mut pointer = std::ptr::null();
        // SAFETY: 输出地址有效，成功 Copy 的拥有引用被立即包装。
        check(unsafe { self.0.copy_action_names(NonNull::from(&mut pointer)) })?;
        let pointer = NonNull::new(pointer.cast_mut()).ok_or("AX 返回空动作数组")?;
        // SAFETY: 动态检查数组及元素类型后读取，不作未检查的泛型转换。
        let value = unsafe { CFRetained::<CFType>::from_raw(pointer.cast()) };
        let array = typed_array(&value)?;
        array
            .iter()
            .take(32)
            .map(|value| {
                value
                    .downcast_ref::<CFString>()
                    .map(ToString::to_string)
                    .ok_or_else(|| "AX 动作不是字符串".into())
            })
            .collect()
    }
    fn scalar(&self, name: &str, issues: &mut Vec<String>) -> Value {
        match self.attribute(name) {
            Ok(value) => {
                if let Some(value) = value.downcast_ref::<CFString>() {
                    let full = value.to_string();
                    let shortened = full.chars().take(1024).collect::<String>();
                    if full.len() != shortened.len() {
                        issues.push(format!("{name} 文字达到长度预算"));
                    }
                    json!(shortened)
                } else if let Some(value) = value.downcast_ref::<CFBoolean>() {
                    json!(value.as_bool())
                } else if let Some(value) = value.downcast_ref::<CFNumber>() {
                    match value.as_f64().filter(|value| value.is_finite()) {
                        Some(value) => json!(value),
                        None => {
                            issues.push(format!("{name} 数值不可表示"));
                            Value::Null
                        }
                    }
                } else {
                    issues.push(format!("{name} 的属性类型不支持"));
                    Value::Null
                }
            }
            Err(error) => {
                if !error.absent() {
                    issues.push(error.into());
                }
                Value::Null
            }
        }
    }
    /// 生成有界 AX 描述并屏蔽安全输入；可选属性失败保留在 issues，必需角色失败则返回错误。
    pub(crate) fn describe(&self) -> Result<Value, String> {
        let role = self.text("AXRole")?;
        let mut issues = Vec::new();
        let subrole = self.scalar("AXSubrole", &mut issues);
        let secure = role == "AXSecureTextField" || subrole == "AXSecureTextField";
        let title = self.scalar("AXTitle", &mut issues);
        let name = if title.as_str().is_some_and(|value| !value.is_empty()) {
            title
        } else {
            self.scalar("AXDescription", &mut issues)
        };
        let value = if secure {
            Value::Null
        } else {
            self.scalar("AXValue", &mut issues)
        };
        let bounds = match self.bounds() {
            Ok(bounds) => bounds.json(),
            Err(error) => {
                issues.push(error);
                Value::Null
            }
        };
        let actions = match self.actions() {
            Ok(actions) => actions,
            Err(error) => {
                issues.push(error);
                vec![]
            }
        };
        let enabled = self.scalar("AXEnabled", &mut issues);
        let focused = self.scalar("AXFocused", &mut issues);
        let selected = self.scalar("AXSelected", &mut issues);
        let expanded = self.scalar("AXExpanded", &mut issues);
        Ok(
            json!({"role":role,"subrole":subrole,"name":name,"value":value,"secure":secure,"enabled":enabled,"focused":focused,"selected":selected,"expanded":expanded,"bounds":bounds,"actions":actions,"issues":issues}),
        )
    }
    /// 同时核验控件语义与祖先业务行，防止保留对象被虚拟列表复用；无法核验时返回错误。
    pub(crate) fn fingerprint(&self) -> Result<String, String> {
        let node = self.describe()?;
        let mut context = Vec::new();
        let mut parent = self.optional_element("AXParent")?;
        for _ in 0..5 {
            let Some(element) = parent else {
                break;
            };
            let mut issues = Vec::new();
            let role = element.text("AXRole")?;
            if matches!(role.as_str(), "AXRow" | "AXCell" | "AXGroup") {
                let mut labels = Vec::new();
                for child in element.children().map_err(String::from)? {
                    if child.text("AXRole").as_deref() == Ok("AXStaticText") {
                        labels.push(child.scalar("AXValue", &mut issues));
                    }
                }
                if !issues.is_empty() {
                    return Err(issues.join("；"));
                }
                context.push(json!([
                    role,
                    element.scalar("AXTitle", &mut issues),
                    labels
                ]));
            }
            if matches!(role.as_str(), "AXWindow" | "AXApplication") {
                break;
            }
            parent = element.optional_element("AXParent")?;
        }
        Ok(json!([
            node["role"],
            node["subrole"],
            node["name"],
            if node["role"] == "AXStaticText" {
                node["value"].clone()
            } else {
                Value::Null
            },
            context
        ])
        .to_string())
    }
    /// 派发前检查 name 是否属于对象当前声明的动作，未知动作不会触发系统输入。
    pub(crate) fn validate_action(&self, name: &str) -> Result<(), String> {
        if self.actions()?.iter().any(|action| action == name) {
            Ok(())
        } else {
            Err("控件不支持该 AX 动作".into())
        }
    }
    /// 只执行实际支持的 AX 动作；调用失败不代表可以回滚已派发的副作用。
    pub(crate) fn perform(&self, name: &str) -> Result<(), String> {
        self.validate_action(name)?;
        // SAFETY: 元素和 CFString 都是本调用拥有的有效对象。
        check(unsafe { self.0.perform_action(&CFString::from_str(name)) })
    }
    /// 派发前检查 AXValue 可写性；不支持、只读或应用无响应时拒绝。
    pub(crate) fn validate_value(&self) -> Result<(), String> {
        let mut writable = 0u8;
        // SAFETY: 输出布尔地址有效，属性名是 AX 规定的值属性。
        check(unsafe {
            self.0.is_attribute_settable(
                &CFString::from_static_str("AXValue"),
                NonNull::from(&mut writable),
            )
        })?;
        if writable == 0 {
            Err("AXValue 不可写".into())
        } else {
            Ok(())
        }
    }
    /// 写入已核验可设置的 AXValue；系统错误由宿主记录为实际派发后的结果。
    pub(crate) fn set_value(&self, value: &str) -> Result<(), String> {
        self.validate_value()?;
        // SAFETY: 元素与字符串在同步调用返回前保持有效。
        check(unsafe {
            self.0.set_attribute_value(
                &CFString::from_static_str("AXValue"),
                &CFString::from_str(value),
            )
        })
    }

}

/// 在深度、节点数、字节与 deadline 预算内遍历；部分读取失败返回原因，不伪造完整树。
pub(crate) fn collect(
    root: &Element,
    deadline: Instant,
) -> (Vec<(Element, Value, String)>, Vec<String>) {
    let mut result = Vec::new();
    let mut warnings = Vec::new();
    let mut queue = std::collections::VecDeque::from([(root.clone(), 0)]);
    let mut seen = Vec::<Element>::new();
    let mut bytes = 0;
    while let Some((element, depth)) = queue.pop_front() {
        if result.len() >= 512 || bytes >= 384 * 1024 || Instant::now() >= deadline {
            warnings.push("AX 遍历达到节点、字节或时间预算".into());
            break;
        }
        if seen.iter().any(|prior| element.same(prior)) {
            continue;
        }
        seen.push(element.clone());
        match element.describe().and_then(|description| {
            element
                .fingerprint()
                .map(|fingerprint| (description, fingerprint))
        }) {
            Ok((mut description, fingerprint)) => {
                description["depth"] = json!(depth);
                bytes += description.to_string().len();
                result.push((element.clone(), description, fingerprint));
            }
            Err(error) => warnings.push(error),
        }
        if depth < 20 {
            match element.children() {
                Ok(children) => {
                    if children.len() == 128 {
                        warnings.push("AX 子节点达到单节点数量预算".into());
                    }
                    for child in children {
                        queue.push_back((child, depth + 1));
                    }
                }
                Err(error) => {
                    if !error.absent() {
                        warnings.push(error.into());
                    }
                }
            }
        } else {
            warnings.push("AX 遍历达到深度预算".into());
        }
        if warnings.len() > 64 {
            warnings.truncate(64);
            warnings.push("AX 错误数量达到预算".into());
            break;
        }
    }
    (result, warnings)
}
