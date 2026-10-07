/// 前缀不是 shell 安全解析器：只对单一字面调用自动匹配，复杂语法留给一次完整审批。
pub(in crate::tool::terminal) fn literal_command(command: &str) -> Option<Vec<String>> {
    #[derive(PartialEq)]
    enum Quote {
        None,
        Single,
        Double,
    }
    let mut quote = Quote::None;
    let mut escaped = false;
    for character in command.chars() {
        if character.is_control() && character != '\t' {
            return None;
        }
        if escaped {
            escaped = false;
            continue;
        }
        if quote == Quote::Single {
            if character == '\'' {
                quote = Quote::None;
            }
            continue;
        }
        if character == '\\' {
            escaped = true;
            continue;
        }
        if character == '$' || character == '`' {
            return None;
        }
        if quote == Quote::Double {
            if character == '"' {
                quote = Quote::None;
            }
            continue;
        }
        match character {
            '\'' => quote = Quote::Single,
            '"' => quote = Quote::Double,
            ';' | '&' | '|' | '<' | '>' | '(' | ')' | '{' | '}' | '*' | '?' | '[' | ']' | '~'
            | '#' | '!' => return None,
            _ => {}
        }
    }
    if escaped || quote != Quote::None {
        return None;
    }
    let words = shlex::split(command)?;
    if words.is_empty() || words[0].is_empty() || words[0].contains('=') {
        return None;
    }
    Some(words)
}
