use std::collections::VecDeque;

/// 字符边界上的有界首尾缓冲；日志洪水不会挤掉启动诊断或最新错误。
pub(crate) struct OutputBuffer {
    head: Vec<char>,
    tail: VecDeque<char>,
    capacity: usize,
    omitted: u64,
}

impl OutputBuffer {
    pub(crate) fn new(capacity: usize) -> Self {
        assert!(capacity >= 2);
        Self {
            head: Vec::new(),
            tail: VecDeque::new(),
            capacity,
            omitted: 0,
        }
    }

    pub(crate) fn push(&mut self, text: &str) {
        let half = self.capacity / 2;
        for ch in text.chars() {
            if self.head.len() < half {
                self.head.push(ch);
            } else {
                if self.tail.len() == self.capacity - half {
                    self.tail.pop_front();
                    self.omitted = self.omitted.saturating_add(1);
                }
                self.tail.push_back(ch);
            }
        }
    }

    pub(crate) fn take(&mut self, limit: usize) -> (String, u64) {
        assert!(limit >= 256);
        let chars: Vec<_> = self.head.drain(..).chain(self.tail.drain(..)).collect();
        let mut omitted = std::mem::take(&mut self.omitted);
        if omitted == 0 && chars.len() <= limit {
            return (chars.into_iter().collect(), 0);
        }
        // 为标记预留固定空间，使多位省略计数也不能突破调用者的输出预算。
        let retained = chars.len().min(limit - 64);
        omitted = omitted.saturating_add((chars.len() - retained) as u64);
        let head = retained / 2;
        let tail = retained - head;
        let mut text: String = chars[..head].iter().collect();
        text.push_str(&format!("\n[已省略 {omitted} 个字符]\n"));
        text.extend(chars[chars.len() - tail..].iter());
        (text, omitted)
    }
}
