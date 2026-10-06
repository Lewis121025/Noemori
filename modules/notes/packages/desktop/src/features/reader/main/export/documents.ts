import { createHash } from "node:crypto";
import { caseFold } from "unicode-case-folding";
import { posix } from "node:path";
import { Fragment, type Node as PmNode } from "prosemirror-model";
import { serializeMarkdown } from "../../shared/markdown/serialize";
import { documentSchema } from "../../shared/markdown/schema";
import { sliceEmbed, findBlockPmPos } from "../../shared/markdown/block-anchor";
import { findHeadingPmPos } from "../../shared/markdown/heading-anchor";
import { isWhiteboardPath } from "../../shared/whiteboard/model";
import type { ExportAnchor } from "../../shared/export-render";
import { EXPORT_LIMITS, type ExportFormat, type ExportIssue } from "../../shared/export";
import type { LinkKind } from "../../shared/api";
import type { NativeExport } from "./native";
import type { ExportRenderer } from "./render";
import type { ExportResources } from "./resources";
import { ExportDocumentStore, type ExportOrigin } from "./document-store";
import { unpackExportSource, type ExportSourceParser } from "./source-parser";
import { isMarkdownTable, portableTable, portableFootnoteAnchor } from "./portable-table";

/** 原始节点位置用于跨文件、嵌入与块锚点映射，不写进原始 schema。 */
type Origin = ExportOrigin;
/** 同一份转换文档和锚点同时用于 PDF、DOCX 及通用 Markdown。 */
export type PreparedExportDocument = {
  path: string;
  output: string;
  doc: PmNode;
  anchors: ExportAnchor[];
  locations: Map<string, string>;
  formulaLocations: Map<PmNode, { path: string; line: number }>;
};

function identity(origin: Origin): string {
  return `${origin.path}\0${origin.position}`;
}
function text(value: string): PmNode {
  return documentSchema.text(value || " ");
}
function paragraph(content: readonly PmNode[] = []): PmNode {
  return documentSchema.node("paragraph", null, content);
}
function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

/** 生成稳定输出路径；转换后名称冲突通过原始路径摘要避让。 */
export function exportOutputNames(
  paths: readonly string[],
  format: ExportFormat,
  sourceDirectories: readonly string[] = [],
): Map<string, string> {
  const result = new Map<string, string>();
  const occupied = new Set<string>();
  const directories = new Map<string, string>();
  const key = (name: string) => caseFold(name.normalize("NFD")).normalize("NFD");
  const reserve = (parent: string, base: string, extension: string, source: string): string => {
    let candidate = `${parent}/${base}${extension}`;
    let attempt = 0;
    while (occupied.has(key(candidate))) {
      candidate = `${parent}/${base}-${shortHash(source)}${attempt ? `-${attempt}` : ""}${extension}`;
      attempt++;
    }
    occupied.add(key(candidate));
    return candidate;
  };
  const directoryPaths = new Set(sourceDirectories);
  if (paths.some((path) => directoryPaths.has(path)))
    throw new Error("输出来源同时声明为文件和目录");
  for (const path of [...new Set([...paths, ...sourceDirectories])].sort()) {
    const parts = path.split("/");
    let parent = "documents";
    let sourceDirectory = "";
    for (const part of directoryPaths.has(path) ? parts : parts.slice(0, -1)) {
      sourceDirectory = sourceDirectory ? `${sourceDirectory}/${part}` : part;
      let outputDirectory = directories.get(sourceDirectory);
      if (outputDirectory === undefined) {
        outputDirectory = reserve(parent, part, "", sourceDirectory);
        directories.set(sourceDirectory, outputDirectory);
      }
      parent = outputDirectory;
    }
    if (directoryPaths.has(path)) {
      result.set(path, parent);
      continue;
    }
    const extension = isWhiteboardPath(path)
      ? format === "png"
        ? "png"
        : "svg"
      : format === "markdown"
        ? "md"
        : format;
    const base = posix.basename(path).replace(/\.[^/.]+$/, "");
    const output = reserve(parent, base, `.${extension}`, path);
    result.set(path, output);
  }
  return result;
}

/**
 * 在原生冻结文件上转换内容；沿用现有文档模型和链接解析，不解释当前编辑 DOM。
 * 每一项必要资源失败均抛出带来源路径的错误，交给整批事务终止。
 */
export class ExportDocuments {
  readonly issues: ExportIssue[] = [];
  readonly pdfDestinations = new Map<string, Set<string>>();
  private readonly store: ExportDocumentStore;
  private readonly parsed = new Map<string, PmNode>();
  private readonly origins = new WeakMap<PmNode, Origin>();
  private readonly aliases = new WeakMap<PmNode, readonly Origin[]>();
  private readonly formulaLocations = new WeakMap<PmNode, { path: string; line: number }>();
  private readonly footnotes = new Map<string, PmNode>();
  private readonly pendingFootnotes = new Set<string>();

  /** @param outputs 明确选择的文档及输出路径；依赖文件不会擅自变为额外交付文档。 */
  constructor(
    private readonly native: NativeExport,
    readonly resources: ExportResources,
    private readonly renderer: ExportRenderer,
    private readonly format: ExportFormat,
    private readonly outputs: ReadonlyMap<string, string>,
    private readonly signal: AbortSignal,
    private readonly parser: ExportSourceParser,
  ) {
    this.store = new ExportDocumentStore(native);
  }

  private async read(path: string): Promise<PmNode> {
    const existing = this.parsed.get(path);
    if (existing) return existing;
    await this.native.include(path);
    const { doc, formulas } = unpackExportSource(await this.parser(await this.native.read(path)));
    doc.descendants((node, position) => {
      this.origins.set(node, { path, position });
      const line = formulas.get(node);
      if (line !== undefined) this.formulaLocations.set(node, { path, line });
    });
    this.parsed.clear();
    this.parsed.set(path, doc);
    return doc;
  }

  /** 转换一篇笔记并建立输出锚点；链接在所有文档完成后统一重写。 */
  async prepare(path: string): Promise<void> {
    this.footnotes.clear();
    this.pendingFootnotes.clear();
    const original = await this.read(path);
    const images: string[] = [];
    original.descendants((node) => {
      if (node.type.name === "image") images.push(String(node.attrs["src"]));
    });
    await this.resources.prefetchImages(images);
    const output = this.outputs.get(path);
    if (!output) throw new Error(`笔记没有输出路径：${path}`);
    const children = await this.children(original, path, [path]);
    children.push(...this.footnotes.values());
    const doc = documentSchema.node("doc", null, children.length ? children : [paragraph()]);
    doc.check();
    const anchors: ExportAnchor[] = [];
    const locations = new Map<string, string>();
    doc.descendants((node, position) => {
      const origin = this.origins.get(node);
      if (!origin || origin.position < 0 || !node.type.isInGroup("block")) return;
      const id = `n${shortHash(path)}_${anchors.length + 1}`;
      anchors.push({ position, id });
      if (!locations.has(identity(origin))) locations.set(identity(origin), id);
      for (const alias of this.aliases.get(node) ?? [])
        if (!locations.has(identity(alias))) locations.set(identity(alias), id);
    });
    await this.store.put(
      {
        path,
        output,
        doc,
        anchors,
        locations,
        formulaLocations: new Map(),
      },
      this.origins,
      this.formulaLocations,
      "prepared",
    );
    this.parsed.clear();
  }

  private async children(
    parent: PmNode,
    from: string,
    chain: readonly string[],
  ): Promise<PmNode[]> {
    const children: PmNode[] = [];
    let content = parent;
    if (
      parent.isTextblock &&
      parent.content.content.some((node) => node.type.name === "html_inline")
    ) {
      const reply = await this.renderer.render({ kind: "inlineHtml", parent: parent.toJSON() });
      if (reply.kind !== "html") throw new Error(`${from}：行内 HTML 转换失败`);
      content = documentSchema.nodeFromJSON(reply.doc);
      const formulas = parent.content.content.filter((node) => node.type.name === "math_inline");
      let index = 0;
      content.descendants((node) => {
        if (node.type.name !== "math_inline") return;
        const original = formulas[index++];
        if (!original || original.attrs["tex"] !== node.attrs["tex"])
          throw new Error(`${from}：HTML 破坏了公式来源`);
        const location = this.formulaLocations.get(original);
        if (location) this.formulaLocations.set(node, location);
      });
      if (index !== formulas.length) throw new Error(`${from}：HTML 丢失了公式`);
    }
    for (const node of content.content.content)
      children.push(...(await this.convert(node, from, chain)));
    if (parent.type.name === "list_item" && children[0]?.type.name !== "paragraph")
      children.unshift(paragraph());
    return children;
  }

  private async convert(node: PmNode, from: string, chain: readonly string[]): Promise<PmNode[]> {
    this.signal.throwIfAborted();
    const name = node.type.name;
    const origin = this.origins.get(node) ?? { path: from, position: -1 };
    const attribute = (key: string) => String(node.attrs[key] ?? "");
    let result: PmNode[];
    if (name === "webpage") {
      // 导出保留可访问的原始入口，不在导出事务中请求或执行远程网页。
      const url = attribute("url");
      return [paragraph([text(url).mark([documentSchema.mark("link", { href: url })])])];
    }
    if (name === "note_embed") {
      const result = await this.embed(node, from, chain);
      const first = result[0];
      if (first) {
        // 首块同时保留被嵌入来源和宿主块身份；重复嵌入不能复用同一别名节点。
        const replacement = first.type.create(first.attrs, first.content, first.marks);
        this.origins.set(replacement, this.origins.get(first) ?? origin);
        this.aliases.set(replacement, [...(this.aliases.get(first) ?? []), origin]);
        const formula = this.formulaLocations.get(first);
        if (formula) this.formulaLocations.set(replacement, formula);
        result[0] = replacement;
      }
      return result;
    }
    if (name.startsWith("comment_")) {
      if (this.format !== "markdown") return [];
      if (attribute("source").includes("--"))
        throw new Error(`${from}：注释包含 HTML 注释不能无损表示的双连字符`);
      return [
        documentSchema.node(name === "comment_block" ? "html_block" : "html_inline", {
          html: `<!--${attribute("source")}-->`,
        }),
      ];
    }
    if (name === "markdown_block") {
      if (/^(---|\+\+\+)\s*\n/.test(node.textContent))
        return this.format === "markdown" ? [node] : [];
      if (/^\s*\[[^\]]+\]:/.test(node.textContent)) return [];
      if (this.format !== "markdown")
        throw new Error(`${from}：存在尚不能可靠转换的 Markdown 源码块`);
      return [node];
    }
    if (name === "html_block" || name === "html_inline") {
      const rendered = await this.renderer.render({
        kind: "html",
        source: attribute("html"),
        inline: name === "html_inline",
      });
      if (rendered.kind !== "html") throw new Error(`${from}：HTML 转换失败`);
      const doc = documentSchema.nodeFromJSON(rendered.doc);
      const transformed = await this.children(doc, from, chain);
      return name === "html_inline"
        ? transformed.flatMap((item) => item.content.content)
        : transformed;
    }
    if (name === "image") {
      const raw = attribute("src");
      const source = /^(https?:|data:)/i.test(raw)
        ? raw
        : await this.required(from, raw, node.attrs["kind"] === "wiki" ? "wiki" : "md");
      const image = await this.resources.image(source, this.format === "docx");
      result = [
        documentSchema.node("image", {
          ...node.attrs,
          src: image.path,
          kind: "md",
          reference: null,
        }),
      ];
    } else if (name === "code_block" && attribute("params").toLowerCase() === "mermaid") {
      const image = await this.resources.diagram(node.textContent, this.format === "docx");
      result = [paragraph([documentSchema.node("image", { src: image.path, alt: "图表" })])];
    } else if (["pdf", "audio", "video"].includes(name)) {
      const raw = attribute("src");
      const source = await this.required(from, raw, node.attrs["kind"] === "wiki" ? "wiki" : "md");
      if (name === "pdf") {
        const page = /(?:#|&)page=(\d+)/i.exec(raw)?.[1];
        const preview = await this.resources.pdf(source, page ? Number(page) : 1);
        result = [
          documentSchema.node("image", {
            src: preview.image.path,
            alt: attribute("alt") || source,
          }),
          this.resourceLink(from, preview.attachment, source),
        ];
      } else
        result = [
          this.resourceLink(
            from,
            await this.resources.attachment(source),
            attribute("alt") || source,
          ),
        ];
    } else if (name === "callout") {
      const title = attribute("title") || attribute("kind");
      result = [
        documentSchema.node("blockquote", null, [
          paragraph([text(title).mark([documentSchema.mark("strong")])]),
          ...(await this.children(node, from, chain)),
        ]),
      ];
    } else if (name === "footnote_ref" || name === "footnote_def") {
      await this.footnote(from, attribute("label"), chain);
      if (name === "footnote_def") return [];
      result = [
        node.type.create({ label: `${shortHash(from)}-${attribute("label")}` }, null, node.marks),
      ];
    } else if (node.isLeaf) result = [node];
    else result = [node.copy(Fragment.fromArray(await this.children(node, from, chain)))];
    if (origin) for (const item of result) this.origins.set(item, origin);
    return result;
  }

  /** 脚注以来源文件和标签定身份；即使定义在嵌入范围之外也收集，循环与歧义明确失败。 */
  private async footnote(from: string, label: string, chain: readonly string[]): Promise<void> {
    const key = `${shortHash(from)}-${label}`;
    if (this.footnotes.has(key)) return;
    if (this.pendingFootnotes.has(key)) throw new Error(`${from}：循环脚注：${label}`);
    const original = await this.read(from);
    const definitions: PmNode[] = [];
    original.descendants((node) => {
      if (node.type.name === "footnote_def" && node.attrs["label"] === label)
        definitions.push(node);
    });
    const definition = definitions[0];
    if (!definition || definitions.some((node) => !node.eq(definition)))
      throw new Error(`${from}：脚注缺失或定义歧义：${label}`);
    this.pendingFootnotes.add(key);
    try {
      const children = await this.children(definition, from, chain);
      const converted = definition.type.create(
        { label: key },
        children.length ? children : [paragraph()],
      );
      const origin = this.origins.get(definition);
      if (origin) this.origins.set(converted, origin);
      this.footnotes.set(key, converted);
    } finally {
      this.pendingFootnotes.delete(key);
    }
  }

  private resourceLink(_from: string, target: string, label: string): PmNode {
    const href = `noemori-export-resource:${target}`;
    return text(label).mark([documentSchema.mark("link", { href })]);
  }

  private async required(from: string, raw: string, kind: LinkKind): Promise<string> {
    const target = await this.native.resolve(from, raw, kind);
    if (target.status !== "resolved") throw new Error(`${from}：必要资源不存在或同名歧义：${raw}`);
    await this.native.include(target.path);
    return target.path;
  }

  private async embed(node: PmNode, from: string, chain: readonly string[]): Promise<PmNode[]> {
    const raw = String(node.attrs["target"] ?? "");
    const path = await this.required(from, raw, "wiki");
    if (isWhiteboardPath(path)) {
      const image = await this.resources.board(path, this.format === "docx");
      return [paragraph([documentSchema.node("image", { src: image.path, alt: path })])];
    }
    if (!path.toLowerCase().endsWith(".md")) throw new Error(`${from}：不支持嵌入此文件：${path}`);
    if (chain.includes(path)) throw new Error(`循环嵌入：${[...chain, path].join(" → ")}`);
    if (chain.length > EXPORT_LIMITS.embedDepth)
      throw new Error(`嵌入超过 ${EXPORT_LIMITS.embedDepth} 层：${path}`);
    const original = await this.read(path);
    const anchor = typeof node.attrs["anchor"] === "string" ? node.attrs["anchor"] : null;
    const sliced = sliceEmbed(original, anchor);
    if (!sliced) throw new Error(`${from}：嵌入锚点不存在：${raw}#${anchor ?? ""}`);
    return this.children(sliced, path, [...chain, path]);
  }

  /** 所有锚点已建立之后重写链接；返回的新节点不改变块长度和锚点位置。 */
  async resolveLinks(): Promise<void> {
    for (const record of this.store.records.values()) {
      const document = await this.store.get(record, this.origins, this.formulaLocations);
      const ids = new WeakMap<PmNode, string>();
      const nextIds = new WeakMap<PmNode, string>();
      for (const anchor of document.anchors) {
        const node = document.doc.nodeAt(anchor.position);
        if (node) ids.set(node, anchor.id);
      }
      const visit = async (node: PmNode): Promise<PmNode[]> => {
        const from = this.origins.get(node)?.path ?? document.path;
        if (node.type.name === "wiki_link") {
          const target = String(node.attrs["target"] ?? "");
          const label = String(node.attrs["alias"] ?? target);
          return this.link(document, from, target, "wiki", text(label).mark(node.marks));
        }
        let current = node;
        if (!node.isLeaf) {
          const children: PmNode[] = [];
          for (const child of node.content.content) children.push(...(await visit(child)));
          current = node.copy(Fragment.fromArray(children));
        }
        const mark = current.marks.find((item) => item.type.name === "link");
        const result = mark
          ? await this.link(
              document,
              from,
              String(mark.attrs["href"] ?? ""),
              "md",
              current.mark(current.marks.filter((item) => item !== mark)),
            )
          : [current];
        const id = ids.get(node);
        if (id && result[0]) nextIds.set(result[0], id);
        const formulaLocation = this.formulaLocations.get(node);
        const origin = this.origins.get(node);
        for (const item of result) {
          if (
            formulaLocation &&
            (item.type.name === "math_inline" || item.type.name === "math_block")
          )
            this.formulaLocations.set(item, formulaLocation);
          if (origin) this.origins.set(item, origin);
        }
        return result;
      };
      // wiki 原子节点会展开成文字，位置须在最终树上重新计算。
      const roots = await visit(document.doc);
      const next = roots[0];
      if (!next || roots.length !== 1 || next.type.name !== "doc")
        throw new Error("链接转换破坏了文档根结构");
      const anchors: ExportAnchor[] = [];
      next.descendants((node, position) => {
        const id = nextIds.get(node);
        if (id) anchors.push({ position, id });
        const location = this.formulaLocations.get(node);
        if (location) document.formulaLocations.set(node, location);
      });
      document.doc = next;
      document.anchors = anchors;
      await this.store.put(document, this.origins, this.formulaLocations, "resolved");
      this.parsed.clear();
    }
  }

  /** 逐篇读取已完成链接替换的文档；调用方完成当前转换后才获取下一篇。 */
  async *preparedDocuments(): AsyncGenerator<PreparedExportDocument, void> {
    for (const record of this.store.records.values())
      yield await this.store.get(record, this.origins, this.formulaLocations);
  }

  private async link(
    document: PreparedExportDocument,
    from: string,
    raw: string,
    kind: LinkKind,
    content: PmNode,
  ): Promise<PmNode[]> {
    const linked = (href: string): PmNode[] => [
      content.mark([...content.marks, documentSchema.mark("link", { href })]),
    ];
    if (/^(https?:|mailto:)/i.test(raw)) return linked(raw);
    // 已转换的附件链接属于包内生成路径，不再次用原笔记身份表解析。
    const resource = raw.startsWith("noemori-export-resource:")
      ? raw.slice("noemori-export-resource:".length)
      : null;
    if (resource !== null && [...this.resources.attachments.values()].includes(resource))
      return linked(encodePath(posix.relative(posix.dirname(document.output), resource)));
    const target = await this.native.resolve(from, raw, kind);
    if (target.status === "resolved") {
      if (!target.path.toLowerCase().endsWith(".md") && !isWhiteboardPath(target.path)) {
        const path = await this.resources.attachment(target.path);
        return linked(encodePath(posix.relative(posix.dirname(document.output), path)));
      }
      const board = this.outputs.get(target.path);
      if (isWhiteboardPath(target.path) && board && !target.anchor)
        return linked(encodePath(posix.relative(posix.dirname(document.output), board)));
      let destination: Pick<PreparedExportDocument, "path" | "output" | "locations"> | undefined =
        this.store.records.get(target.path);
      let anchor: string | undefined;
      if (target.anchor) {
        const inCurrent = [...document.locations.keys()].some((key) =>
          key.startsWith(`${target.path}\0`),
        );
        const original = destination || inCurrent ? await this.read(target.path) : null;
        const position = original
          ? target.anchor.startsWith("^")
            ? findBlockPmPos(original, target.anchor.slice(1))
            : findHeadingPmPos(original, target.anchor)
          : null;
        if (position !== null) {
          const key = identity({ path: target.path, position });
          // 嵌入正文的内部锚点属于当前产物，不能因原笔记没有独立输出而丢失。
          const local = document.locations.get(key);
          if (local !== undefined) {
            destination = document;
            anchor = local;
          } else anchor = destination?.locations.get(key);
        }
      }
      if (destination && (!target.anchor || anchor)) {
        if (destination.path === document.path && !anchor) {
          anchor = document.anchors[0]?.id;
          if (!anchor) throw new Error(`${document.path}：本文链接缺少可定位的正文起点`);
        }
        if (this.format === "pdf" && anchor && destination.path !== document.path) {
          let requested = this.pdfDestinations.get(destination.path);
          if (!requested) {
            requested = new Set();
            this.pdfDestinations.set(destination.path, requested);
          }
          requested.add(anchor);
        }
        const relative =
          destination.path === document.path
            ? ""
            : encodePath(posix.relative(posix.dirname(document.output), destination.output));
        return linked(`${relative}${anchor ? `#${anchor}` : ""}` || "#");
      }
    }
    this.issues.push({ path: from, severity: "warning", message: `普通链接未导出为跳转：${raw}` });
    return [content, documentSchema.text(`（${raw}）`, content.marks)];
  }
}

/** 对包内 URL 的每个路径分量编码，保留相对路径层级。 */
export function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** 生成可直接离线渲染的文档；只有已验证并冻结的图片可以进入页面。 */
export async function documentWithImages(
  document: PreparedExportDocument,
  resources: ExportResources,
): Promise<PmNode> {
  const data = new Map<string, string>();
  const visit = async (node: PmNode): Promise<PmNode> => {
    if (node.type.name === "image") {
      const path = String(node.attrs["src"]);
      let source = data.get(path);
      if (source === undefined) {
        source = await resources.imageData(path);
        data.set(path, source);
      }
      return node.type.create({ ...node.attrs, src: source }, null, node.marks);
    }
    if (node.isLeaf) return node;
    const children: PmNode[] = [];
    for (const child of node.content.content) children.push(await visit(child));
    return node.copy(Fragment.fromArray(children));
  };
  return visit(document.doc);
}

/** 通用 Markdown 使用标准链接及 HTML 锚点，保持输出文件移动后的定位能力。 */
export function portableMarkdown(document: PreparedExportDocument): string {
  const ids = new Map(document.anchors.map((anchor) => [anchor.position, anchor.id]));
  const visit = (node: PmNode, position: number): PmNode[] => {
    let current = node;
    if (node.type.name === "image")
      current = node.type.create(
        {
          ...node.attrs,
          src: encodePath(
            posix.relative(posix.dirname(document.output), String(node.attrs["src"])),
          ),
        },
        null,
        node.marks,
      );
    if (!node.isLeaf) {
      const children: PmNode[] = [];
      node.forEach((child, offset) => children.push(...visit(child, position + 1 + offset)));
      current = node.copy(Fragment.fromArray(children));
    }
    if (current.type.name === "table" && !isMarkdownTable(current))
      current = documentSchema.node("html_block", { html: portableTable(current) });
    if (current.type.name === "footnote_def") {
      const first = current.firstChild;
      const html = `<a id="${portableFootnoteAnchor(String(current.attrs["label"]))}"></a>`;
      const children =
        first?.type.name === "paragraph"
          ? [
              first.copy(
                Fragment.fromArray([
                  documentSchema.node("html_inline", { html }),
                  ...first.content.content,
                ]),
              ),
              ...current.content.content.slice(1),
            ]
          : [documentSchema.node("html_block", { html }), ...current.content.content];
      current = current.copy(Fragment.fromArray(children));
    }
    const highlight = current.marks.find((mark) => mark.type.name === "highlight");
    if (highlight && current.isInline)
      return [
        documentSchema.node("html_inline", { html: "<mark>" }),
        current.mark(current.marks.filter((mark) => mark !== highlight)),
        documentSchema.node("html_inline", { html: "</mark>" }),
      ];
    const id = ids.get(position);
    if (!id) return [current];
    const html = `<a id="${id}"></a>`;
    if (current.type.name === "paragraph" || current.type.name === "heading")
      return [
        current.copy(
          Fragment.fromArray([
            documentSchema.node("html_inline", { html }),
            ...current.content.content,
          ]),
        ),
      ];
    return [documentSchema.node("html_block", { html }), current];
  };
  // 文档根没有正文位置；位置 0 属于首个子块，不能复用为根节点的锚点。
  const children: PmNode[] = [];
  document.doc.forEach((child, offset) => children.push(...visit(child, offset)));
  return serializeMarkdown(document.doc.copy(Fragment.fromArray(children)));
}
