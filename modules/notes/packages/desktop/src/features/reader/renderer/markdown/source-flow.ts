import type { Node as PmNode } from "prosemirror-model";
import type { SourceNode } from "./source-map";
import { sourceLinePrefix } from "./source-text";
import { listNeedsParagraphBoundary } from "../../shared/markdown/layout-serialization";

/**
 * 空段与块类型共同决定边界；新增引用必须结束懒延续，删除空段移除它占用的空行。
 * @param source 原始完整源码；未改变的节点及相邻边界逐字复用。
 * @param previous 与原文对应的容器映射。
 * @param current 当前容器；处理空段、块数量或块类型改变的同类流式容器。
 * @param render 递归生成已映射节点的源码。
 * @param replacement 生成新增节点的源码片段。
 * @returns 局部容器源码；不属于空白布局的修改返回 null，由既有渲染路径处理。
 * @throws 节点序列化失败时继续抛错，交由保存流程保留恢复记录。
 */
export function renderFlowLayout(
  source: string,
  previous: SourceNode,
  current: PmNode,
  render: (before: SourceNode, after: PmNode) => string,
  replacement: (node: PmNode, at: number) => string,
): string | null {
  if (
    !previous.node.sameMarkup(current) ||
    !["doc", "blockquote", "list_item", "footnote_def"].includes(current.type.name) ||
    previous.children.length === 0 ||
    (previous.node.childCount === current.childCount &&
      ![...previous.node.content.content, ...current.content.content].some(isEmptyParagraph) &&
      current.content.content.every((node, index) => node.type === previous.node.child(index).type))
  )
    return null;
  const before = previous.children;
  const after = current.content.content;
  const matches = matchChildren(before, after);
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const continuation = continuationPrefix(source, previous);
  const boundary = (left: PmNode, right: PmNode) => {
    const item = right.firstChild;
    const lead = item?.firstChild;
    const empty =
      typeof item?.attrs["checked"] !== "boolean" &&
      (lead === null ||
        lead === undefined ||
        (lead.type.name === "paragraph" && lead.content.size === 0));
    const listBoundary =
      left.type.name === "paragraph" &&
      ["bullet_list", "ordered_list"].includes(right.type.name) &&
      listNeedsParagraphBoundary(
        right.type.name === "ordered_list" ? Number(right.attrs["order"]) : null,
        empty,
      );
    const tight =
      current.type.name === "list_item" &&
      current.attrs["spread"] !== true &&
      !isEmptyParagraph(right) &&
      !listBoundary &&
      !(["blockquote", "callout"].includes(left.type.name) && right.type.name === "paragraph") &&
      !(left.type.name === "paragraph" && right.type.name === "paragraph");
    return (newline + continuation).repeat(isEmptyParagraph(left) || tight ? 1 : 2);
  };
  const first = before[0];
  const last = before.at(-1);
  if (first === undefined || last === undefined) return null;
  const firstMatch = matches[0];
  const firstCurrent = after[0];
  let result =
    firstMatch === 0 && firstCurrent !== undefined && sameLayout(first.node, firstCurrent)
      ? source.slice(previous.start, first.start)
      : containerHead(source, previous, first, firstCurrent);
  after.forEach((node, index) => {
    const originalIndex = matches[index];
    const original = originalIndex === undefined ? undefined : before[originalIndex];
    if (index > 0) {
      const prior = after[index - 1];
      const priorIndex = matches[index - 1];
      const priorOriginal = priorIndex === undefined ? undefined : before[priorIndex];
      if (prior === undefined) throw new Error("空白布局缺少相邻节点");
      result +=
        original !== undefined &&
        priorOriginal !== undefined &&
        priorIndex !== undefined &&
        originalIndex === priorIndex + 1 &&
        sameLayout(original.node, node) &&
        sameLayout(priorOriginal.node, prior)
          ? source.slice(priorOriginal.end, original.start)
          : boundary(prior, node);
    }
    result +=
      original === undefined || original.implicit !== undefined
        ? replacement(node, first.start)
        : render(original, node);
  });
  const final = after.at(-1);
  if (matches.at(-1) === before.length - 1 && final !== undefined && sameLayout(last.node, final))
    result += source.slice(last.end, previous.end);
  else if (
    current.type.name === "doc" &&
    final !== undefined &&
    !isEmptyParagraph(final) &&
    /[\r\n]$/.test(source.slice(previous.start, previous.end))
  )
    result += newline;
  return result;
}

function isEmptyParagraph(node: PmNode): boolean {
  return node.type.name === "paragraph" && node.content.size === 0;
}

function sameLayout(left: PmNode, right: PmNode): boolean {
  return left.type === right.type && isEmptyParagraph(left) === isEmptyParagraph(right);
}

function matchChildren(before: SourceNode[], after: readonly PmNode[]): Array<number | undefined> {
  const used = new Set<number>();
  const identities = new Map<PmNode, number[]>();
  for (let index = before.length - 1; index >= 0; index--) {
    const node = before[index]?.node;
    if (node === undefined) continue;
    const indices = identities.get(node) ?? [];
    indices.push(index);
    identities.set(node, indices);
  }
  const matches = after.map((node) => identities.get(node)?.pop());
  matches.forEach((index) => {
    if (index !== undefined) used.add(index);
  });
  after.forEach((node, at) => {
    if (matches[at] !== undefined) return;
    const index = before.findIndex((item, at) => !used.has(at) && item.node.eq(node));
    if (index < 0) return;
    used.add(index);
    matches[at] = index;
  });
  for (const empty of [false, true]) {
    const candidates = before.flatMap((item, index) =>
      !used.has(index) && isEmptyParagraph(item.node) === empty ? [index] : [],
    );
    const targets = after.flatMap((node, index) =>
      matches[index] === undefined && isEmptyParagraph(node) === empty ? [index] : [],
    );
    if (candidates.length === targets.length)
      targets.forEach((index, at) => {
        const candidate = candidates[at];
        if (candidate !== undefined) {
          matches[index] = candidate;
          used.add(candidate);
        }
      });
  }
  const unmatched = before.map((_, index) => index).filter((index) => !used.has(index));
  const changed = after.map((_, index) => index).filter((index) => matches[index] === undefined);
  if (unmatched.length === changed.length)
    changed.forEach((index, at) => {
      matches[index] = unmatched[at];
    });
  return matches;
}

function continuationPrefix(source: string, previous: SourceNode): string {
  const type = previous.node.type.name;
  if (type === "doc") return "";
  const outer = sourceLinePrefix(source, previous.start).replace(/[^\t >]/g, " ");
  if (type === "blockquote") return outer + "> ";
  if (type === "footnote_def") return outer + "    ";
  const marker = /^(?:[-+*]|\d+[.)])(?:[ \t]+|$)/.exec(source.slice(previous.start, previous.end));
  return outer + " ".repeat(Math.max(2, marker?.[0].length ?? 2));
}

function containerHead(
  source: string,
  previous: SourceNode,
  first: SourceNode,
  current: PmNode | undefined,
): string {
  if (previous.node.type.name === "doc") return "";
  const head = source.slice(previous.start, first.start).split(/\r\n|\r|\n/)[0] ?? "";
  return current !== undefined && !isEmptyParagraph(current)
    ? head.trimEnd() + " "
    : head.trimEnd();
}
