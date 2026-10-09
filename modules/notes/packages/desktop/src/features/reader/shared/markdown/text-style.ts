import type { Nodes, Parent, PhrasingContent } from "mdast";
import palette from "./text-palette.json";

/** 有限配色由编辑器、剪贴板和 Word 模板共同使用，源码保存稳定的浅色值。 */
export const textPalette = palette;
/** 文字颜色与高亮颜色分别受其调色板约束。 */
export type TextColor = keyof typeof palette.text;
/** 高亮背景颜色；黄色继续兼容 Obsidian 的双等号语法。 */
export type HighlightColor = keyof typeof palette.highlight;
/** 标准 HTML 可无损表示的文字样式。 */
export type TextStyle =
  | { kind: "underline" }
  | { kind: "text_color"; color: TextColor }
  | { kind: "highlight"; color: HighlightColor };
/** 带源码位置的样式父节点；子文字位置保持原值供保真保存与导航使用。 */
export type StyledText = Parent & {
  type: "textStyle";
  style: TextStyle;
  children: PhrasingContent[];
};

declare module "mdast" {
  interface RootContentMap {
    textStyle: StyledText;
  }
  interface PhrasingContentMap {
    textStyle: StyledText;
  }
}

/** 验证外部输入的文字配色；不抛出异常。 */
export function isTextColor(value: unknown): value is TextColor {
  return typeof value === "string" && Object.hasOwn(palette.text, value);
}
/** 验证外部输入的高亮配色；不抛出异常。 */
export function isHighlightColor(value: unknown): value is HighlightColor {
  return typeof value === "string" && Object.hasOwn(palette.highlight, value);
}

function normalize(value: string): string {
  const rgb = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i.exec(value.trim());
  return rgb
    ? "#" +
        rgb
          .slice(1)
          .map((part) => Number(part).toString(16).padStart(2, "0"))
          .join("")
    : value.trim().toLowerCase();
}

/** 从标准 CSS 色值识别调色板颜色；未知值返回 null，不做近似替换。 */
export function paletteColor(kind: "text", value: string): TextColor | null;
export function paletteColor(kind: "highlight", value: string): HighlightColor | null;
export function paletteColor(
  kind: "text" | "highlight",
  value: string,
): TextColor | HighlightColor | null {
  const color = normalize(value);
  const colors = kind === "text" ? palette.text : palette.highlight;
  for (const [key, entry] of Object.entries(colors)) {
    if (entry.light !== color && entry.dark !== color) continue;
    if (kind === "text" && isTextColor(key)) return key;
    if (kind === "highlight" && isHighlightColor(key)) return key;
  }
  return null;
}

/** 只识别单一、受控的 CSS 声明；附加样式必须继续由原始 HTML 承载。 */
export function cssTextStyle(tag: string, css: string): TextStyle | null {
  const match = /^\s*(color|background-color)\s*:\s*([^;]+)\s*;?\s*$/i.exec(css);
  if (!match) return null;
  if (tag === "span" && match[1]?.toLowerCase() === "color") {
    const color = paletteColor("text", match[2] ?? "");
    return color ? { kind: "text_color", color } : null;
  }
  if (tag === "mark" && match[1]?.toLowerCase() === "background-color") {
    const color = paletteColor("highlight", match[2] ?? "");
    return color ? { kind: "highlight", color } : null;
  }
  return null;
}

/** 返回可移植的开闭标签；调用者必须已验证样式，不接受任意 HTML 属性。 */
export function textStyleTags(style: TextStyle): readonly [string, string] {
  switch (style.kind) {
    case "underline":
      return ["<u>", "</u>"];
    case "text_color":
      return [`<span style="color: ${palette.text[style.color].light}">`, "</span>"];
    case "highlight":
      return [
        `<mark style="background-color: ${palette.highlight[style.color].light}">`,
        "</mark>",
      ];
  }
}

function opening(value: string): { tag: string; style: TextStyle } | null {
  const plain = /^<(u|mark)\s*>$/i.exec(value);
  if (plain)
    return {
      tag: plain[1]!.toLowerCase(),
      style:
        plain[1]!.toLowerCase() === "u"
          ? { kind: "underline" }
          : { kind: "highlight", color: "yellow" },
    };
  const styled = /^<(span|mark)\s+style\s*=\s*(["'])(.*?)\2\s*>$/i.exec(value);
  if (!styled) return null;
  const tag = styled[1]!.toLowerCase();
  const style = cssTextStyle(tag, styled[3] ?? "");
  return style ? { tag, style } : null;
}

function group(children: PhrasingContent[]): PhrasingContent[] {
  const stack: Array<{ index: number; tag: string; style: TextStyle | null }> = [];
  const pairs = new Map<number, { end: number; style: TextStyle }>();
  // 一次配对，避免每个开标签重新扫描余下内容；未知同名标签也参与嵌套边界。
  for (let index = 0; index < children.length; index++) {
    const child = children[index]!;
    if (child.type !== "html" || /\/\s*>$/.test(child.value)) continue;
    const tag = /^<(\/?)(u|span|mark)(?:\s[^]*)?>$/i.exec(child.value);
    if (!tag) continue;
    const name = tag[2]!.toLowerCase();
    if (tag[1] === "") stack.push({ index, tag: name, style: opening(child.value)?.style ?? null });
    else {
      const start = stack.pop();
      if (start?.tag !== name) {
        // 交叉闭合不能成为可编辑样式，保留这一组原始标签供源码编辑。
        stack.length = 0;
      } else if (start.style !== null) pairs.set(start.index, { end: index, style: start.style });
    }
  }
  function content(from: number, to: number): PhrasingContent[] {
    const result: PhrasingContent[] = [];
    for (let index = from; index < to; index++) {
      const child = children[index]!;
      const pair = pairs.get(index);
      if (!pair) {
        result.push(child);
        continue;
      }
      const closing = children[pair.end]!;
      result.push({
        type: "textStyle",
        style: pair.style,
        children: content(index + 1, pair.end),
        ...(child.position && closing.position
          ? { position: { start: child.position.start, end: closing.position.end } }
          : {}),
      });
      index = pair.end;
    }
    return result;
  }
  return content(0, children.length);
}

/**
 * 将匹配的受控行内 HTML 包装转为样式节点；保留未知 HTML 与所有原始位置。
 * @param node 标准 Markdown 语法树；原地转换正文、标题及表格的行内内容。
 * @returns 无返回值；不平衡或无法表示的标签不转换，也不抛出异常。
 */
export function restoreTextStyles(node: Nodes): void {
  if (!("children" in node)) return;
  node.children.forEach(restoreTextStyles);
  if (
    node.type === "paragraph" ||
    node.type === "heading" ||
    node.type === "tableCell" ||
    node.type === "strong" ||
    node.type === "emphasis" ||
    node.type === "delete" ||
    node.type === "highlight" ||
    node.type === "link" ||
    node.type === "linkReference" ||
    node.type === "textStyle"
  )
    node.children = group(node.children);
}
