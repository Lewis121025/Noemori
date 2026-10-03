import { join } from "node:path";
import type { Node as PmNode } from "prosemirror-model";
import type { PreparedExportDocument } from "./documents";
import { exportResourceHash } from "./resources";

/** Pandoc 的 JSON 值；只由受控文档映射生成，不接受原始 OpenXML 注入。 */
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type PandocNode = { t: string; c?: Json };
/** 一篇固定版本的 Pandoc 文档和必须保留的公式数量。 */
export type PandocDocument = { value: Json; formulas: number };
/** 文档显示尺寸使用 CSS 像素；不能把双倍栅格采样尺寸误当作排版尺寸。 */
export type ExportImageSize = { width: number; height: number };
const emptyAttr: Json = ["", [], []];
const make = (t: string, c?: Json): PandocNode => (c === undefined ? { t } : { t, c });

/**
 * 将已处理依赖的文档映射到 Pandoc 原生结构，标题、表格、脚注和数学均有显式分支。
 * @throws 未映射内容、缺失脚注或不属于任务的资源路径时拒绝生成。
 */
export function toPandoc(
  document: PreparedExportDocument,
  resourceDirectory: string,
  expandedMath?: ReadonlyMap<PmNode, string>,
  images: ReadonlyMap<string, ExportImageSize> = new Map(),
): PandocDocument {
  const anchors = new Map(document.anchors.map((anchor) => [anchor.position, anchor.id]));
  const positions = new WeakMap<PmNode, number>();
  const definitions = new Map<string, PmNode>();
  const referenced = new Set<string>();
  document.doc.descendants((node, position) => {
    positions.set(node, position);
    if (node.type.name === "footnote_def") definitions.set(String(node.attrs["label"]), node);
    if (node.type.name === "footnote_ref") referenced.add(String(node.attrs["label"]));
  });
  let formulas = 0;
  const activeNotes = new Set<string>();
  function math(node: PmNode, display: boolean): PandocNode {
    const source = expandedMath ? expandedMath.get(node) : String(node.attrs["tex"]);
    if (source === undefined) throw new Error("公式没有经过严格编译");
    formulas++;
    // Word 书签不改变公式外观；独立校验用它把脚注、正文中的公式还原到源顺序。
    return make("Span", [
      [`noemori_eq_${formulas}`, [], []],
      [make("Math", [make(display ? "DisplayMath" : "InlineMath"), source])],
    ]);
  }
  function inline(parent: PmNode): PandocNode[] {
    return parent.content.content.flatMap((node): PandocNode[] => {
      let content: PandocNode[];
      switch (node.type.name) {
        case "text":
          content = (node.text ?? "")
            .split(/(\s+)/u)
            .filter(Boolean)
            .map((part) =>
              /^\s+$/u.test(part)
                ? make(part.includes("\n") ? "SoftBreak" : "Space")
                : make("Str", part),
            );
          break;
        case "hard_break":
          content = [make("LineBreak")];
          break;
        case "math_inline":
          content = [math(node, false)];
          break;
        case "image": {
          const source = String(node.attrs["src"]);
          exportResourceHash(source);
          const size = images.get(source);
          if (!size) throw new Error("DOCX 图片缺少已验证的显示尺寸");
          content = [
            make("Image", [
              [
                "",
                [],
                [
                  ["width", `${size.width}px`],
                  ["height", `${size.height}px`],
                ],
              ],
              [make("Str", String(node.attrs["alt"] ?? ""))],
              [join(resourceDirectory, source), String(node.attrs["title"] ?? "")],
            ]),
          ];
          break;
        }
        case "footnote_ref": {
          const label = String(node.attrs["label"]);
          const definition = definitions.get(label);
          if (!definition || activeNotes.has(label)) throw new Error(`脚注缺失或循环：${label}`);
          activeNotes.add(label);
          content = [make("Note", blocks(definition))];
          activeNotes.delete(label);
          break;
        }
        default:
          throw new Error(`DOCX 不支持此行内结构：${node.type.name}`);
      }
      for (const mark of [...node.marks].reverse()) {
        switch (mark.type.name) {
          case "strong":
            content = [make("Strong", content)];
            break;
          case "em":
            content = [make("Emph", content)];
            break;
          case "strike":
            content = [make("Strikeout", content)];
            break;
          case "highlight":
            content = [make("Span", [["", [], [["custom-style", "NoemoriHighlight"]]], content])];
            break;
          case "code":
            content = [make("Code", [emptyAttr, node.textContent])];
            break;
          case "link":
            content = [
              make("Link", [
                emptyAttr,
                content,
                [String(mark.attrs["href"]), String(mark.attrs["title"] ?? "")],
              ]),
            ];
            break;
          default:
            throw new Error(`DOCX 不支持此文字格式：${mark.type.name}`);
        }
      }
      return content;
    });
  }
  function block(node: PmNode): PandocNode[] {
    const id = anchors.get(positions.get(node) ?? -1) ?? "";
    const attr: Json = [id, [], []];
    switch (node.type.name) {
      case "paragraph":
        return [make("Para", [...(id ? [make("Span", [attr, []])] : []), ...inline(node)])];
      case "heading":
        return [make("Header", [Number(node.attrs["level"]), attr, inline(node)])];
      case "blockquote":
        return [make("BlockQuote", blocks(node))];
      case "horizontal_rule":
        return [make("HorizontalRule")];
      case "code_block":
        return [
          make("CodeBlock", [
            [id, String(node.attrs["params"] ?? "") ? [String(node.attrs["params"])] : [], []],
            node.textContent,
          ]),
        ];
      case "math_block":
        return [make("Para", [math(node, true)])];
      case "footnote_def":
        return referenced.has(String(node.attrs["label"])) ? [] : blocks(node);
      case "bullet_list":
      case "ordered_list": {
        const items = node.content.content.map((item) => {
          const result = blocks(item);
          if (typeof item.attrs["checked"] === "boolean")
            result.unshift(make("Plain", [make("Str", item.attrs["checked"] ? "☑" : "☐")]));
          return result;
        });
        return [
          node.type.name === "bullet_list"
            ? make("BulletList", items)
            : make("OrderedList", [
                [Number(node.attrs["order"]), make("Decimal"), make("Period")],
                items,
              ]),
        ];
      }
      case "table": {
        const first = node.firstChild;
        if (!first) throw new Error("DOCX 表格缺少列");
        const align = (cell: PmNode) =>
          make(
            cell.attrs["align"] === "center"
              ? "AlignCenter"
              : cell.attrs["align"] === "right"
                ? "AlignRight"
                : "AlignLeft",
          );
        const row = (row: PmNode): Json => [
          emptyAttr,
          row.content.content.map((cell) => [
            emptyAttr,
            align(cell),
            1,
            1,
            [
              make(
                "Plain",
                cell.type.name === "table_header" ? [make("Strong", inline(cell))] : inline(cell),
              ),
            ],
          ]),
        ];
        const specs = first.content.content.map((cell) => [align(cell), make("ColWidthDefault")]);
        const rows = node.content.content;
        const firstBody = rows.findIndex((row) =>
          row.content.content.some((cell) => cell.type.name !== "table_header"),
        );
        const headerCount = firstBody === -1 ? rows.length : firstBody;
        return [
          make("Table", [
            attr,
            [null, []],
            specs,
            [emptyAttr, rows.slice(0, headerCount).map(row)],
            [[emptyAttr, 0, [], rows.slice(headerCount).map(row)]],
            [emptyAttr, []],
          ]),
        ];
      }
      default:
        throw new Error(`DOCX 不支持此段落结构：${node.type.name}`);
    }
  }
  function blocks(node: PmNode): PandocNode[] {
    return node.content.content.flatMap((child) => {
      const content = block(child);
      const id = anchors.get(positions.get(child) ?? -1);
      // 列表、引用和公式等结构没有原生 Attr，Div 书签保留其完整块目标。
      return id &&
        content.length &&
        !["paragraph", "heading", "code_block", "table"].includes(child.type.name)
        ? [make("Div", [[id, [], []], content])]
        : content;
    });
  }
  const content = blocks(document.doc);
  return {
    value: { "pandoc-api-version": [1, 23, 1, 2], meta: {}, blocks: content },
    formulas,
  };
}
