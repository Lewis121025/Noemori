use crate::Error;
use std::{
    ops::ControlFlow,
    path::Path,
    time::{Duration, Instant},
};
use tree_sitter::{ParseOptions, Parser};

const MAX_COMMANDS: usize = 256;
const MAX_WRAPPERS: usize = 8;

/// 只有已确认的字面分派和脚本包装可以继续拆解；其他 shell 执行语义保留完整审批。
#[derive(Clone, Copy)]
enum CommandShape<'a> {
    Direct,
    Opaque,
    Script(&'a str),
    Dispatch(&'a [String]),
}

/// 整条调用的分析结果；任何无法完整解析的包装都保留完整 argv，禁止仅批准其中一部分。
pub(super) struct Analysis {
    pub(super) commands: Vec<Vec<String>>,
    pub(super) wrappers: Vec<Vec<String>>,
    pub(super) fully_parsed: bool,
}

pub(super) fn analyze(shell: &Path, login: bool, source: &str) -> Result<Analysis, Error> {
    if source.is_empty()
        || source.contains('\0')
        || source.chars().count() > super::super::contract::MAX_COMMAND_CHARS
    {
        return Err(Error::Config(
            "命令规则检查输入为空、含 NUL 或超过命令预算".into(),
        ));
    }
    let shell = shell
        .to_str()
        .ok_or_else(|| Error::Config("命令策略的 shell 路径必须为 UTF-8".into()))?;
    let deadline = Instant::now() + Duration::from_millis(100);
    match simple_commands(source, deadline)? {
        Some(commands) => expand(commands, 0, deadline),
        None => Ok(Analysis {
            commands: vec![vec![
                shell.into(),
                if login { "-lc" } else { "-c" }.into(),
                source.into(),
            ]],
            wrappers: Vec::new(),
            fully_parsed: false,
        }),
    }
}

fn simple_commands(source: &str, deadline: Instant) -> Result<Option<Vec<Vec<String>>>, Error> {
    if Instant::now() >= deadline {
        return Err(Error::Config("命令语法分析超时，命令未执行".into()));
    }
    let mut parser = Parser::new();
    parser
        .set_language(&tree_sitter_bash::LANGUAGE.into())
        .map_err(|error| Error::Config(format!("命令语法解析器初始化失败：{error}")))?;
    let mut progress = |_: &tree_sitter::ParseState| {
        if Instant::now() >= deadline {
            ControlFlow::Break(())
        } else {
            ControlFlow::Continue(())
        }
    };
    let tree = parser
        .parse_with_options(
            &mut |offset, _| source.as_bytes().get(offset..).unwrap_or_default(),
            None,
            Some(ParseOptions::new().progress_callback(&mut progress)),
        )
        .ok_or_else(|| Error::Config("命令语法分析超时，命令未执行".into()))?;
    if tree.root_node().has_error() {
        return Ok(None);
    }
    let mut pending = vec![tree.root_node()];
    let mut commands = Vec::new();
    while let Some(node) = pending.pop() {
        match node.kind() {
            "program" | "list" | "pipeline" => {
                let mut cursor = node.walk();
                let mut children = Vec::new();
                for child in node.children(&mut cursor) {
                    if child.is_named() {
                        children.push(child);
                    } else if !matches!(child.kind(), ";" | "&&" | "||" | "|") {
                        return Ok(None);
                    }
                }
                pending.extend(children.into_iter().rev());
            }
            "command" => {
                let mut cursor = node.walk();
                if node.named_children(&mut cursor).any(|child| {
                    !matches!(
                        child.kind(),
                        "command_name"
                            | "word"
                            | "number"
                            | "string"
                            | "raw_string"
                            | "concatenation"
                    )
                }) {
                    return Ok(None);
                }
                let text = node
                    .utf8_text(source.as_bytes())
                    .map_err(|error| Error::Config(format!("命令语法节点无效：{error}")))?;
                let Some(words) = super::super::rules::literal_command(text) else {
                    return Ok(None);
                };
                commands.push(words);
                if commands.len() > MAX_COMMANDS {
                    return Ok(None);
                }
            }
            _ => return Ok(None),
        }
    }
    Ok((!commands.is_empty()).then_some(commands))
}

fn expand(commands: Vec<Vec<String>>, depth: usize, deadline: Instant) -> Result<Analysis, Error> {
    let mut result = Analysis {
        commands: Vec::new(),
        wrappers: Vec::new(),
        fully_parsed: true,
    };
    for argv in commands {
        let shape = command_shape(&argv);
        let inner = if depth < MAX_WRAPPERS {
            match shape {
                CommandShape::Script(script) => simple_commands(script, deadline)?,
                CommandShape::Dispatch(words) => Some(vec![words.to_vec()]),
                CommandShape::Direct | CommandShape::Opaque => None,
            }
        } else {
            None
        };
        if let Some(inner) = inner {
            let expanded = expand(inner, depth + 1, deadline)?;
            result.fully_parsed &= expanded.fully_parsed;
            result.wrappers.push(argv);
            result.wrappers.extend(expanded.wrappers);
            result.commands.extend(expanded.commands);
        } else {
            result.fully_parsed &= matches!(shape, CommandShape::Direct);
            result.commands.push(argv);
        }
        if result.commands.len() + result.wrappers.len() > MAX_COMMANDS {
            return Err(Error::Config(
                "命令包装展开后超过 256 条预算，命令未执行".into(),
            ));
        }
    }
    Ok(result)
}

fn command_shape(argv: &[String]) -> CommandShape<'_> {
    if let Some(script) = shell_script(argv) {
        return CommandShape::Script(script);
    }
    if is_shell(argv) || matches!(argv[0].as_str(), "eval" | "." | "source") {
        return CommandShape::Opaque;
    }
    if !matches!(argv[0].as_str(), "exec" | "command" | "builtin")
        || (argv[0] == "command"
            && argv
                .get(1)
                .is_some_and(|word| matches!(word.as_str(), "-v" | "-V")))
    {
        return CommandShape::Direct;
    }
    let mut start = 1;
    if argv[0] == "command" && argv.get(start).is_some_and(|word| word == "-p") {
        start += 1;
    }
    if argv.get(start).is_some_and(|word| word == "--") {
        start += 1;
    }
    if start < argv.len() && !argv[start].starts_with('-') {
        CommandShape::Dispatch(&argv[start..])
    } else {
        CommandShape::Opaque
    }
}

fn shell_script(argv: &[String]) -> Option<&str> {
    if !is_shell(argv) {
        return None;
    }
    match argv.get(1)?.as_str() {
        "-c" | "-lc" | "-cl" => argv.get(2).map(String::as_str),
        "-l" | "--login" if argv.get(2)?.as_str() == "-c" => argv.get(3).map(String::as_str),
        _ => None,
    }
}

fn is_shell(argv: &[String]) -> bool {
    argv.first()
        .and_then(|word| Path::new(word).file_name())
        .and_then(|name| name.to_str())
        .is_some_and(|name| matches!(name, "bash" | "zsh" | "sh"))
}
