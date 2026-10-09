import { DOMParser as PmParser, Fragment, type Node as PmNode } from "prosemirror-model";
import DOMPurify from "dompurify";
import { documentSchema } from "../../shared/markdown/schema";
import { cssTextStyle } from "../../shared/markdown/text-style";

/**
 * 将静态 HTML 映射到现有内容模型；图片先记录来源，不在解析阶段联网。
 * @throws 清理或解析不能保留可见文字时拒绝。
 */
export function parseExportHtml(source: string): PmNode {
  const parsed = new DOMParser().parseFromString(source, "text/html");
  const supported = new Set([
    "html",
    "head",
    "body",
    "p",
    "div",
    "span",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "a",
    "strong",
    "b",
    "em",
    "i",
    "s",
    "del",
    "strike",
    "mark",
    "u",
    "code",
    "pre",
    "blockquote",
    "ul",
    "ol",
    "li",
    "table",
    "thead",
    "tbody",
    "tfoot",
    "tr",
    "td",
    "th",
    "img",
    "br",
    "hr",
    "details",
    "summary",
  ]);
  for (const element of Array.from(parsed.querySelectorAll("*"))) {
    if (!supported.has(element.localName))
      throw new Error(`HTML 元素不能可靠转换：${element.localName}`);
    if (
      (element.hasAttribute("style") && !cssTextStyle(element.localName, element.getAttribute("style") ?? "")) ||
      element.hasAttribute("hidden") ||
      element.hasAttribute("srcset")
    )
      throw new Error("HTML 包含尚不能可靠保留的样式、隐藏或响应式内容");
    for (const name of ["colspan", "rowspan"])
      if (element.hasAttribute(name) && element.getAttribute(name) !== "1")
        throw new Error("HTML 跨行或跨列表格不能转换为当前文档模型");
  }
  const fragment = DOMPurify.sanitize(source, {
    RETURN_DOM_FRAGMENT: true,
    FORBID_TAGS: ["style", "iframe", "object", "embed", "form", "input", "button"],
  });
  if (!(fragment instanceof DocumentFragment)) throw new Error("HTML 内容无法安全解析");
  for (const image of Array.from(fragment.querySelectorAll("img"))) {
    image.dataset.imageSrc = image.getAttribute("src") ?? "";
    image.dataset.imageKind = "md";
    image.removeAttribute("src");
    image.removeAttribute("srcset");
  }
  const root = document.createElement("div");
  root.append(fragment);
  if (root.textContent !== parsed.body.textContent) throw new Error("HTML 清理导致文字内容变化");
  const doc = PmParser.fromSchema(documentSchema).parse(root);
  if (root.textContent?.trim() !== "" && doc.textContent.trim() === "")
    throw new Error("HTML 转换无法保留可见文字");
  return doc;
}

/** 保留 HTML 标签与原行内节点的上下文；不允许解析静默吞掉原有节点。 */
export function parseInlineExportHtml(parent: PmNode): PmNode {
  const prefix = `NOEMORI${crypto.randomUUID().replaceAll("-", "")}NODE`;
  const originals: PmNode[] = [];
  const source = parent.content.content
    .map((node) => {
      if (node.type.name === "html_inline") return String(node.attrs["html"]);
      const index = originals.push(node) - 1;
      return `${prefix}${index}END`;
    })
    .join("");
  const parsed = parseExportHtml(source);
  if (parsed.childCount !== 1 || parsed.firstChild?.type.name !== "paragraph")
    throw new Error("行内 HTML 不能改变所在段落的块结构");
  const counts = originals.map(() => 0);
  const token = new RegExp(`${prefix}(\\d+)END`, "g");
  const children = parsed.firstChild.content.content.flatMap((node): PmNode[] => {
    if (!node.isText) return [node];
    const value = node.text ?? "";
    const result: PmNode[] = [];
    let start = 0;
    for (const match of value.matchAll(token)) {
      if (match.index > start)
        result.push(documentSchema.text(value.slice(start, match.index), node.marks));
      const index = Number(match[1]);
      const original = originals[index];
      if (!original) throw new Error("HTML 行内节点身份无效");
      counts[index] = (counts[index] ?? 0) + 1;
      let marks = original.marks;
      for (const mark of node.marks) marks = mark.addToSet(marks);
      result.push(original.mark(marks));
      start = match.index + match[0].length;
    }
    if (start < value.length) result.push(documentSchema.text(value.slice(start), node.marks));
    return result;
  });
  if (counts.some((count) => count !== 1)) throw new Error("HTML 结构导致原有行内内容丢失或重复");
  return parent.copy(Fragment.fromArray(children));
}
