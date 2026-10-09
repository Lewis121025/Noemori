import { createHash } from "node:crypto";
import type { Node as PmNode } from "prosemirror-model";
import { isTextColor, isHighlightColor, textStyleTags } from "../../shared/markdown/text-style";

/** 只有单一表头、矩形数据及逐列一致的对齐才能无损表示为 GFM 表格。 */
export function isMarkdownTable(table: PmNode): boolean {
  const first = table.firstChild;
  return (
    first !== null &&
    first.content.content.every((cell) => cell.type.name === "table_header") &&
    table.content.content
      .slice(1)
      .every(
        (row) =>
          row.childCount === first.childCount &&
          row.content.content.every(
            (cell, index) =>
              cell.type.name === "table_cell" &&
              cell.attrs["align"] === first.child(index).attrs["align"],
          ),
      )
  );
}

/** HTML 表格中的脚注与标准 Markdown 定义通过显式锚点连接，不依赖阅读器生成的 ID。 */
export function portableFootnoteAnchor(label: string): string {
  return `footnote_${createHash("sha256").update(label).digest("hex")}`;
}

function escape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function inline(node: PmNode): string {
  let content: string;
  switch (node.type.name) {
    case "text":
      content = escape(node.text ?? "");
      break;
    case "hard_break":
      content = "<br>";
      break;
    case "math_inline":
      content = escape(`$${String(node.attrs["tex"])}$`);
      break;
    case "html_inline":
      content = String(node.attrs["html"]);
      break;
    case "image":
      content = `<img src="${escape(String(node.attrs["src"]))}" alt="${escape(String(node.attrs["alt"] ?? ""))}" title="${escape(String(node.attrs["title"] ?? ""))}">`;
      break;
    case "footnote_ref": {
      const label = String(node.attrs["label"]);
      content = `<sup><a href="#${portableFootnoteAnchor(label)}">[${escape(label)}]</a></sup>`;
      break;
    }
    default:
      throw new Error(`HTML 表格不能可靠保留此行内内容：${node.type.name}`);
  }
  const tags: Record<string, string> = {
    strong: "strong",
    em: "em",
    strike: "del",
    code: "code",
    underline: "u",
  };
  for (const mark of [...node.marks].reverse()) {
    if (mark.type.name === "link")
      content = `<a href="${escape(String(mark.attrs["href"]))}" title="${escape(String(mark.attrs["title"] ?? ""))}">${content}</a>`;
    else if (mark.type.name === "highlight" || mark.type.name === "text_color") {
      const color: unknown = mark.attrs["color"];
      const style =
        mark.type.name === "highlight" && isHighlightColor(color)
          ? ({ kind: "highlight", color } as const)
          : mark.type.name === "text_color" && isTextColor(color)
            ? ({ kind: "text_color", color } as const)
            : null;
      if (!style) throw new Error("HTML 表格包含未知配色");
      const [open, close] = textStyleTags(style);
      content = open + content + close;
    } else {
      const tag = tags[mark.type.name];
      if (!tag) throw new Error(`HTML 表格不能可靠保留此文字格式：${mark.type.name}`);
      content = `<${tag}>${content}</${tag}>`;
    }
  }
  return content;
}

/** 不能用 GFM 表示的表格输出标准 HTML；单元格类型、对齐、公式与资源引用保持原含义。 */
export function portableTable(table: PmNode): string {
  return `<table>\n${table.content.content
    .map(
      (row) =>
        `<tr>${row.content.content
          .map((cell) => {
            const tag = cell.type.name === "table_header" ? "th" : "td";
            const align = cell.attrs["align"];
            const attribute =
              align === "left" || align === "center" || align === "right"
                ? ` align="${align}"`
                : "";
            return `<${tag}${attribute}>${cell.content.content.map(inline).join("")}</${tag}>`;
          })
          .join("")}</tr>`,
    )
    .join("\n")}\n</table>`;
}
