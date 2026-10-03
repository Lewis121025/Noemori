/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { documentSchema as schema } from "@reader/shared/markdown/schema";
import { portableMarkdown } from "@reader/main/export/documents";
import {
  isMarkdownTable,
  portableFootnoteAnchor,
  portableTable,
} from "@reader/main/export/portable-table";

describe("EXP-MARKDOWN 非 GFM 表格的独立 HTML 检查", () => {
  it("表格中的格式、公式、图像、脚注及特殊字符保持可离线读取", () => {
    const cell = schema.node("table_cell", { align: "right" }, [
      schema.text('< & " >', [schema.mark("strong"), schema.mark("em"), schema.mark("strike")]),
      schema.node("hard_break"),
      schema.node("math_inline", { tex: "x < y \\& z" }),
      schema.text("code", [schema.mark("code")]),
      schema.text("highlight", [schema.mark("highlight")]),
      schema.text("link", [schema.mark("link", { href: "other.md?a=1&b=2", title: 'quote"' })]),
      schema.node("image", { src: "resources/picture.png", alt: 'alt"', title: "<image>" }),
      schema.node("footnote_ref", { label: "list-note" }),
    ]);
    const table = schema.node("table", null, [schema.node("table_row", null, [cell])]);
    const definition = schema.node("footnote_def", { label: "list-note" }, [
      schema.node("bullet_list", null, [
        schema.node("list_item", null, [schema.node("paragraph", null, schema.text("脚注正文"))]),
      ]),
    ]);
    const output = portableMarkdown({
      path: "a.md",
      output: "documents/a.md",
      doc: schema.node("doc", null, [table, definition]),
      anchors: [],
      locations: new Map(),
      formulaLocations: new Map(),
    });
    const html = new DOMParser().parseFromString(output, "text/html");
    expect(html.querySelectorAll("td")).toHaveLength(1);
    expect(html.querySelector("td")?.getAttribute("align")).toBe("right");
    for (const tag of ["strong", "em", "del"])
      expect(html.querySelector(tag)?.textContent).toBe('< & " >');
    expect(html.querySelector("br")).not.toBeNull();
    expect(html.querySelector("td")?.textContent).toContain("$x < y \\& z$");
    expect(html.querySelector("code")?.textContent).toBe("code");
    expect(html.querySelector("mark")?.textContent).toBe("highlight");
    expect(html.querySelector("td > a")?.getAttribute("href")).toBe("other.md?a=1&b=2");
    expect(html.querySelector("img")?.getAttribute("src")).toBe("../resources/picture.png");
    expect(html.querySelector("img")?.getAttribute("alt")).toBe('alt"');
    const anchor = portableFootnoteAnchor("list-note");
    expect(html.querySelector("sup a")?.getAttribute("href")).toBe(`#${anchor}`);
    expect(html.getElementById(anchor)).not.toBeNull();
    expect(output).toContain("脚注正文");
  });

  it("表格有缺列或不一致对齐时不能冒充 GFM 的同列语义", () => {
    const header = schema.node("table_header", { align: "center" }, schema.text("header"));
    const cell = schema.node("table_cell", { align: "right" }, schema.text("body"));
    const table = schema.node("table", null, [
      schema.node("table_row", null, [header]),
      schema.node("table_row", null, [cell, cell]),
    ]);
    expect(isMarkdownTable(table)).toBe(false);
    const html = new DOMParser().parseFromString(portableTable(table), "text/html");
    expect(html.querySelectorAll("th")).toHaveLength(1);
    expect(html.querySelectorAll("td")).toHaveLength(2);
    expect(html.querySelector("th")?.getAttribute("align")).toBe("center");
    expect(isMarkdownTable(schema.nodes.table!.create())).toBe(false);
  });

  it("未经过依赖转换的节点不能静默丢失", () => {
    const table = schema.node("table", null, [
      schema.node("table_row", null, [
        schema.node("table_cell", null, [schema.node("wiki_link", { target: "unresolved" })]),
      ]),
    ]);
    expect(() => portableTable(table)).toThrow("不能可靠保留");
  });
});
