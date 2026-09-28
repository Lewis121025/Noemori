//! 有序命中流：每个成立分支只保留下一处位置，避免单篇高频词构造全量区间数组。

use std::{cmp::Reverse, collections::BinaryHeap, ops::Range};

use super::{find_folded, matches, scopes, Doc, Node};
use crate::{Error, SearchCancellation};

type Stream<'a> = Box<dyn Iterator<Item = Result<Range<usize>, Error>> + 'a>;

/// 按正文起止位置输出唯一证据；失败 OR 分支、否定词与不成立范围均不能贡献命中。
pub(super) fn occurrences<'a>(
    node: &'a Node,
    doc: &'a Doc<'a>,
    cancellation: &'a SearchCancellation,
) -> Result<impl Iterator<Item = Result<Range<usize>, Error>> + 'a, Error> {
    let stream = evidence(node, doc, None, false, cancellation)?;
    let mut previous = None;
    Ok(stream.filter_map(move |item| match item {
        Ok(range) if previous.as_ref() == Some(&range) => None,
        Ok(range) => {
            previous = Some(range.clone());
            Some(Ok(range))
        }
        Err(error) => Some(Err(error)),
    }))
}

fn evidence<'a>(
    node: &'a Node,
    doc: &'a Doc<'a>,
    scope: Option<Range<usize>>,
    negated: bool,
    cancellation: &'a SearchCancellation,
) -> Result<Stream<'a>, Error> {
    if matches(node, doc, scope.as_ref(), cancellation)? == negated {
        return Ok(Box::new(std::iter::empty()));
    }
    match node {
        Node::And(children) | Node::Or(children) => {
            let streams = children
                .iter()
                .map(|child| evidence(child, doc, scope.clone(), negated, cancellation))
                .collect::<Result<Vec<_>, _>>()?;
            Ok(Box::new(Merged::new(streams)?))
        }
        Node::Not(child) => evidence(child, doc, scope, !negated, cancellation),
        Node::Line(child) | Node::Section(child) => {
            let mut ranges = scopes(node, doc, scope.as_ref());
            let mut current: Option<Stream<'a>> = None;
            Ok(Box::new(std::iter::from_fn(move || loop {
                if let Some(item) = current.as_mut().and_then(Iterator::next) {
                    return Some(item);
                }
                let range = ranges.next()?;
                match evidence(child, doc, Some(range), negated, cancellation) {
                    Ok(stream) => current = Some(stream),
                    Err(error) => return Some(Err(error)),
                }
            })))
        }
        Node::Term(term) if !negated => {
            let range = scope.unwrap_or(0..doc.body.len());
            let mut start = range.start;
            let needle = term
                .chars()
                .flat_map(char::to_lowercase)
                .collect::<Vec<_>>();
            Ok(Box::new(std::iter::from_fn(move || {
                match find_folded(&doc.body[start..range.end], &needle, cancellation) {
                    Ok(Some((from, to))) => {
                        let hit = start + from..start + to;
                        start += to;
                        Some(Ok(hit))
                    }
                    Ok(None) => None,
                    Err(error) => Some(Err(error)),
                }
            })))
        }
        Node::Regex(regex) if !negated => {
            let range = scope.unwrap_or(0..doc.body.len());
            Ok(Box::new(
                regex
                    .find_iter(&doc.body[range.clone()])
                    .map(move |hit| {
                        cancellation.check()?;
                        Ok(range.start + hit.start()..range.start + hit.end())
                    })
                    .filter(|item| match item {
                        Ok(range) => !range.is_empty(),
                        Err(_) => true,
                    }),
            ))
        }
        _ => Ok(Box::new(std::iter::empty())),
    }
}

/// 合并各分支的有序流，空间随表达式分支数增长，和整篇命中数无关。
struct Merged<'a> {
    streams: Vec<Stream<'a>>,
    heads: BinaryHeap<Reverse<(usize, usize, usize)>>,
}

impl<'a> Merged<'a> {
    fn new(mut streams: Vec<Stream<'a>>) -> Result<Self, Error> {
        let mut heads = BinaryHeap::new();
        for (index, stream) in streams.iter_mut().enumerate() {
            if let Some(range) = stream.next() {
                let range = range?;
                heads.push(Reverse((range.start, range.end, index)));
            }
        }
        Ok(Self { streams, heads })
    }
}

impl Iterator for Merged<'_> {
    type Item = Result<Range<usize>, Error>;

    fn next(&mut self) -> Option<Self::Item> {
        let Reverse((start, end, index)) = self.heads.pop()?;
        if let Some(item) = self.streams[index].next() {
            match item {
                Ok(range) => self.heads.push(Reverse((range.start, range.end, index))),
                Err(error) => return Some(Err(error)),
            }
        }
        Some(Ok(start..end))
    }
}
