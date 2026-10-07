mod parse;

use crate::Error;
use serde::{Deserialize, Serialize};
use std::{path::Path, sync::Arc};

const MAX_RULES: usize = 256;
const MAX_POLICY_BYTES: usize = 1024 * 1024;

/// 命令规则的约束强度；多个规则同时匹配时，禁止优先于逐次审批，逐次审批优先于允许。
/// 允许仅解除命令规则本身的审批要求，不会扩大文件或网络权限。
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalCommandDecision {
    /// 在既有资源权限内允许；扩大权限仍须匹配独立的资源授权。
    Allow,
    /// 每次执行都须由宿主确认，已保存的资源许可不能跳过本次命令审批。
    Prompt,
    /// 在启动或申请额外权限前拒绝本次命令。
    Forbidden,
}

/// 前缀中一个参数位置的字面值或候选集合；不解释通配符、变量或正则表达式。
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(untagged)]
pub enum TerminalCommandPattern {
    /// 该参数须与字符串完全一致。
    Word(String),
    /// 该参数须与至少一个候选字符串完全一致。
    AnyOf(Vec<String>),
}

impl TerminalCommandPattern {
    fn matches(&self, word: &str) -> bool {
        match self {
            Self::Word(value) => value == word,
            Self::AnyOf(values) => values.iter().any(|value| value == word),
        }
    }

    fn words(&self) -> &[String] {
        match self {
            Self::Word(word) => std::slice::from_ref(word),
            Self::AnyOf(words) => words,
        }
    }
}

/// 宿主设定的命令前缀规则；内联示例在载入时验证，不运行任何示例命令。
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TerminalCommandRule {
    /// 1..32 个参数位置；首位置是程序名，路径不会自动转换成别名或 basename。
    pub pattern: Vec<TerminalCommandPattern>,
    /// 该规则对匹配命令施加的约束。
    pub decision: TerminalCommandDecision,
    /// 可展示给宿主和模型的原因或建议替代操作。
    pub justification: Option<String>,
    /// 预期匹配的字面 argv 示例。
    #[serde(default)]
    pub matches: Vec<Vec<String>>,
    /// 预期不匹配的字面 argv 示例。
    #[serde(default)]
    pub not_matches: Vec<Vec<String>>,
}

impl TerminalCommandRule {
    fn matches_argv(&self, argv: &[String]) -> bool {
        argv.len() >= self.pattern.len()
            && self
                .pattern
                .iter()
                .zip(argv)
                .all(|(pattern, word)| pattern.matches(word))
    }

    fn validate(&self) -> Result<(), Error> {
        if self.pattern.is_empty() || self.pattern.len() > 32 {
            return Err(Error::Config("命令规则前缀须包含 1..32 个参数位置".into()));
        }
        for (index, pattern) in self.pattern.iter().enumerate() {
            let words = pattern.words();
            if words.is_empty()
                || words.len() > 64
                || words.iter().any(|word| {
                    word.contains('\0') || word.len() > 8192 || (index == 0 && word.is_empty())
                })
            {
                return Err(Error::Config("命令规则参数或候选集合无效".into()));
            }
        }
        if self
            .justification
            .as_ref()
            .is_some_and(|reason| reason.trim().is_empty() || reason.chars().count() > 2048)
        {
            return Err(Error::Config("命令规则原因须为 1..2048 个字符".into()));
        }
        if self.matches.len() + self.not_matches.len() > 128 {
            return Err(Error::Config("命令规则最多包含 128 个内联示例".into()));
        }
        for (examples, expected) in [(&self.matches, true), (&self.not_matches, false)] {
            for argv in examples {
                if argv.is_empty()
                    || argv.len() > 128
                    || argv
                        .iter()
                        .any(|word| word.contains('\0') || word.len() > 8192)
                    || self.matches_argv(argv) != expected
                {
                    return Err(Error::Config(
                        "命令规则内联示例与声明不一致或参数无效".into(),
                    ));
                }
            }
        }
        Ok(())
    }
}

/// 一条实际匹配规则及其命令位置；规则只记录一次，避免长命令重复复制审批原因。
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TerminalCommandMatch {
    /// 规则在宿主策略中的位置，可关联宿主的配置来源。
    pub rule_index: usize,
    /// 本次分析结果中受此规则约束的命令位置。
    pub command_indices: Vec<usize>,
    /// 显式 shell 或内建分派包装的位置；拆解内部命令不能消除包装自身的禁止或审批规则。
    pub wrapper_indices: Vec<usize>,
    /// 此匹配的约束强度。
    pub decision: TerminalCommandDecision,
    /// 宿主设定的原因。
    pub justification: Option<String>,
}

/// 无副作用的命令检查结果，既供执行门禁使用，也供宿主展示和检查规则文件。
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TerminalCommandEvaluation {
    /// 所有匹配中的最严格决定；None 表示没有匹配，不额外授予资源权限。
    pub decision: Option<TerminalCommandDecision>,
    /// 安全拆解的各条 argv；复杂语法保留为整个 shell 调用，不只检查其中的部分命令。
    pub commands: Vec<Vec<String>>,
    /// 已安全拆解的显式包装 argv；隐式宿主启动 shell 不作为模型命令的包装参与匹配。
    pub wrappers: Vec<Vec<String>>,
    /// 命中的全部规则和原因。
    pub matches: Vec<TerminalCommandMatch>,
    /// 是否完整拆解了原命令及已识别的 shell 包装。
    pub fully_parsed: bool,
    /// 是否每条最终调用都得到允许规则覆盖，且没有审批或禁止规则。
    pub all_commands_allowed: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct StoredPolicy {
    version: u32,
    rules: Vec<TerminalCommandRule>,
}

/// 已验证且不可由模型修改的宿主命令策略；合并多层配置时把全部规则传入同一实例。
#[derive(Clone, Default)]
pub struct TerminalCommandPolicy {
    rules: Arc<[TerminalCommandRule]>,
}

impl TerminalCommandPolicy {
    /// 验证规则及内联示例，构造不持有文件或进程的策略。
    /// # 错误
    /// 前缀、示例、原因无效，或规则超过 256 项/1 MiB 时返回配置错误。
    pub fn new(rules: Vec<TerminalCommandRule>) -> Result<Self, Error> {
        if rules.len() > MAX_RULES {
            return Err(Error::Config("命令规则超过 256 项上限".into()));
        }
        for rule in &rules {
            rule.validate()?;
        }
        let policy = Self {
            rules: rules.into(),
        };
        if policy.to_json()?.len() > MAX_POLICY_BYTES {
            return Err(Error::Config("命令规则超过 1 MiB 预算".into()));
        }
        Ok(policy)
    }

    /// 从宿主读取的严格版本化 JSON 载入规则；模型不能指定文件或动态重载规则。
    /// # 错误
    /// 未知字段、版本不支持、数据超预算或规则验证失败时拒绝整份策略。
    pub fn from_json(bytes: &[u8]) -> Result<Self, Error> {
        if bytes.len() > MAX_POLICY_BYTES {
            return Err(Error::Config("命令规则超过 1 MiB 预算".into()));
        }
        let stored: StoredPolicy = serde_json::from_slice(bytes)
            .map_err(|error| Error::Config(format!("命令规则 JSON 无效：{error}")))?;
        if stored.version != 1 {
            return Err(Error::Config("命令规则版本不支持".into()));
        }
        Self::new(stored.rules)
    }

    /// 导出供宿主持久保存的版本化 JSON，不读取或写入任何文件。
    /// # 错误
    /// JSON 编码失败时返回配置错误。
    pub fn to_json(&self) -> Result<String, Error> {
        serde_json::to_string(&StoredPolicy {
            version: 1,
            rules: self.rules.to_vec(),
        })
        .map_err(|error| Error::Config(format!("命令规则编码失败：{error}")))
    }

    /// 返回可审查的规则；策略生命周期内不接受模型或审批回调的原地修改。
    pub fn rules(&self) -> &[TerminalCommandRule] {
        &self.rules
    }

    /// 按实际 shell 和登录语义检查命令；只拆解纯字面调用和安全线性组合，不执行 shell。
    /// # 错误
    /// 输入超预算、shell 路径无效、解析器初始化失败或分析超时则拒绝检查和执行。
    pub fn evaluate(
        &self,
        shell: &Path,
        login: bool,
        command: &str,
    ) -> Result<TerminalCommandEvaluation, Error> {
        let analysis = parse::analyze(shell, login, command)?;
        let mut matches = Vec::new();
        for (rule_index, rule) in self.rules.iter().enumerate() {
            let command_indices: Vec<_> = analysis
                .commands
                .iter()
                .enumerate()
                .filter_map(|(index, argv)| rule.matches_argv(argv).then_some(index))
                .collect();
            let wrapper_indices: Vec<_> = analysis
                .wrappers
                .iter()
                .enumerate()
                .filter_map(|(index, argv)| rule.matches_argv(argv).then_some(index))
                .collect();
            if !command_indices.is_empty() || !wrapper_indices.is_empty() {
                matches.push(TerminalCommandMatch {
                    rule_index,
                    command_indices,
                    wrapper_indices,
                    decision: rule.decision,
                    justification: rule.justification.clone(),
                });
            }
        }
        // 不能用某个局部前缀自动批准尚未完整理解的脚本；完整 shell 前缀规则仍可明确覆盖它。
        let decision = matches
            .iter()
            .map(|matched| matched.decision)
            .max()
            .or_else(|| {
                (!analysis.fully_parsed && !self.rules.is_empty())
                    .then_some(TerminalCommandDecision::Prompt)
            });
        let all_commands_allowed = decision == Some(TerminalCommandDecision::Allow)
            && (0..analysis.commands.len()).all(|index| {
                matches.iter().any(|matched| {
                    matched.decision == TerminalCommandDecision::Allow
                        && matched.command_indices.contains(&index)
                })
            });
        Ok(TerminalCommandEvaluation {
            decision,
            commands: analysis.commands,
            wrappers: analysis.wrappers,
            matches,
            fully_parsed: analysis.fully_parsed,
            all_commands_allowed,
        })
    }
}

#[cfg(test)]
#[path = "../../../../../test/agent/terminal/unit/command_policy.rs"]
mod tests;
