import { isUint8Array } from "node:util/types";
import { posix } from "node:path";
import type { Node as PmNode } from "prosemirror-model";
import { isWhiteboardPath } from "../../shared/whiteboard/model";
import type { ExportIssue, ExportPlan, ExportRequest } from "../../shared/export";
import type { NativeExport } from "./native";
import type { ExportRenderer } from "./render";
import { ExportResources, decodeImageData } from "./resources";
import { ExportDocuments, exportOutputNames, documentWithImages } from "./documents";
import { exportDocx } from "./pandoc";
import { packExportDocument, type ExportComputation } from "./computation";
import { errorText, ExportFailure } from "./errors";
import { unpackExportSource, type ExportSourceParser } from "./source-parser";

/** 暂存成功后的实际交付范围，保存对话框根据此结果显示正确扩展名。 */
export type ExportArtifacts = {
  single: string | null;
  extension: string;
  name: string;
  issues: ExportIssue[];
};
/** 阶段报告由协调器绑定具体窗口和任务，不能影响事务是否已经提交。 */
export type ExportReporter = {
  progress: (completed: number, total: number, path: string) => void;
  plan: (plan: ExportPlan) => void;
};

/**
 * 生成整批候选产物，任一必要内容错误均在提交前抛出。
 * @returns 最终输出描述；调用方仍须选择目标并调用原生 publish。
 */
export async function prepareArtifacts(
  native: NativeExport,
  request: ExportRequest,
  renderer: ExportRenderer,
  signal: AbortSignal,
  report: ExportReporter,
  parser: ExportSourceParser,
  compute: ExportComputation,
): Promise<ExportArtifacts> {
  const initial = native.snapshot.files.map((file) => file.path);
  const resources = new ExportResources(native, renderer, signal, compute);
  if (request.format === "archive")
    return archiveArtifacts(native, initial, resources, renderer, report, signal, parser);
  const notes = initial.filter((path) => path.toLowerCase().endsWith(".md"));
  const boards = initial.filter(isWhiteboardPath);
  const raw = initial.filter((path) => !notes.includes(path) && !boards.includes(path));
  const boardFormat = request.format === "png" || request.format === "svg";
  if (boardFormat && (notes.length > 0 || boards.length === 0))
    throw new Error("PNG / SVG 导出需要选择白板；混合内容请选择文档或原格式导出");
  if (!boardFormat && notes.length === 0 && initial.length > 0)
    throw new Error("所选范围没有 Markdown 笔记，请选择白板或原格式导出");
  const outputs = exportOutputNames(
    [...notes, ...boards],
    request.format,
    native.snapshot.directories,
  );
  for (const directory of native.snapshot.directories) {
    const output = outputs.get(directory);
    if (!output) throw new Error(`目录没有输出路径：${directory}`);
    await native.directory(output);
  }
  const documents = new ExportDocuments(
    native,
    resources,
    renderer,
    request.format,
    outputs,
    signal,
    parser,
  );
  const errors: ExportIssue[] = [];
  for (const [index, path] of notes.entries()) {
    signal.throwIfAborted();
    report.progress(index, notes.length + boards.length, path);
    try {
      await documents.prepare(path);
    } catch (error) {
      errors.push(
        ...(error instanceof ExportFailure
          ? error.issues
          : [{ path, severity: "error" as const, message: errorText(error) }]),
      );
    }
  }
  if (errors.length) throw new ExportFailure(errors);
  await documents.resolveLinks();
  const retained = new Set<string>();
  for (const path of raw) {
    const output = `attachments/${path}`;
    await native.copy(path, output);
    retained.add(output);
  }
  for (const [index, path] of boards.entries()) {
    signal.throwIfAborted();
    report.progress(notes.length + index, notes.length + boards.length, path);
    const output = outputs.get(path);
    if (!output) throw new Error("白板缺少输出路径");
    const svg = await compute({
      kind: "whiteboard",
      bytes: await native.read(path),
      layout: "native",
    });
    if (!isUint8Array(svg)) throw new Error("白板转换响应无效");
    let bytes = svg;
    if (request.format === "png") {
      const result = await renderer.render({
        kind: "raster",
        source: `data:image/svg+xml;base64,${Buffer.from(bytes).toString("base64")}`,
        scale: 2,
      });
      if (result.kind !== "image") throw new Error(`${path}：白板未生成 PNG`);
      bytes = decodeImageData(result.data).bytes;
    }
    await native.write(output, bytes);
    retained.add(output);
  }
  await native.seal();
  report.plan({
    files: [
      ...native.snapshot.files.map((file) => file.path),
      ...new Map(resources.downloads.map((item) => [item.path, item.url])).values(),
    ],
    bytes: native.snapshot.bytes + native.snapshot.resourceBytes,
    issues: documents.issues,
  });
  let converted = 0;
  for await (const document of documents.preparedDocuments()) {
    signal.throwIfAborted();
    report.progress(converted++, notes.length, document.path);
    let bytes: Uint8Array;
    if (request.format === "pdf") {
      const checked = await compute({ kind: "checkMath", document: packExportDocument(document) });
      if (checked !== null) throw new Error("公式校验响应无效");
      const links = new Set<string>();
      document.doc.descendants((node) => {
        for (const mark of node.marks)
          if (mark.type.name === "link") links.add(String(mark.attrs["href"]));
      });
      bytes = await renderer.pdf(
        (await documentWithImages(document, resources)).toJSON(),
        document.anchors,
        {
          links: [...links],
          destinations: [...(documents.pdfDestinations.get(document.path) ?? [])],
        },
      );
    } else if (request.format === "docx")
      bytes = await exportDocx(
        document,
        native.snapshot.outputDirectory,
        signal,
        compute,
        undefined,
        resources.images,
      );
    else {
      const converted = await compute({ kind: "markdown", document: packExportDocument(document) });
      if (!isUint8Array(converted)) throw new Error("Markdown 转换响应无效");
      bytes = converted;
    }
    if (request.format === "pdf" && Buffer.from(bytes.subarray(0, 5)).toString() !== "%PDF-")
      throw new Error("打印未返回有效 PDF");
    await native.write(document.output, bytes);
    retained.add(document.output);
  }
  for (const path of resources.attachments.values()) retained.add(path);
  if (request.format === "markdown") for (const path of resources.images.keys()) retained.add(path);
  await native.retain([...retained]);
  const selectedFile =
    request.scope.kind === "selection" &&
    request.scope.paths.length === 1 &&
    initial.includes(request.scope.paths[0] ?? "");
  const single = selectedFile && retained.size === 1 ? ([...retained][0] ?? null) : null;
  return {
    single,
    extension: single ? posix.extname(single).slice(1) : "zip",
    name: single ? posix.basename(single) : "Noemori 导出.zip",
    issues: documents.issues,
  };
}

async function archiveArtifacts(
  native: NativeExport,
  initial: string[],
  resources: ExportResources,
  renderer: ExportRenderer,
  report: ExportReporter,
  signal: AbortSignal,
  parser: ExportSourceParser,
): Promise<ExportArtifacts> {
  const visited = new Set<string>();
  const issues: ExportIssue[] = [];
  const ordinary: { from: string; raw: string; target: string }[] = [];
  async function collect(path: string): Promise<void> {
    if (visited.has(path)) return;
    signal.throwIfAborted();
    visited.add(path);
    await native.include(path);
    if (!path.toLowerCase().endsWith(".md")) return;
    let doc: PmNode;
    try {
      doc = unpackExportSource(await parser(await native.read(path))).doc;
    } catch (error) {
      issues.push({
        path,
        severity: "warning",
        message: `原始字节已保留，无法解析附加引用：${errorText(error)}`,
      });
      return;
    }
    const references: { raw: string; kind: "wiki" | "md"; embedded: boolean; image: boolean }[] =
      [];
    const html: string[] = [];
    const inspect = (node: PmNode): void => {
      const name = node.type.name;
      if (name === "html_block" || name === "html_inline") html.push(String(node.attrs["html"]));
      if (name === "wiki_link")
        references.push({
          raw: String(node.attrs["target"]),
          kind: "wiki",
          embedded: false,
          image: false,
        });
      if (name === "note_embed")
        references.push({
          raw: String(node.attrs["target"]),
          kind: "wiki",
          embedded: true,
          image: false,
        });
      if (["image", "pdf", "audio", "video"].includes(name))
        references.push({
          raw: String(node.attrs["src"]),
          kind: node.attrs["kind"] === "wiki" ? "wiki" : "md",
          embedded: true,
          image: name === "image",
        });
      for (const mark of node.marks)
        if (mark.type.name === "link")
          references.push({
            raw: String(mark.attrs["href"]),
            kind: "md",
            embedded: false,
            image: false,
          });
    };
    doc.descendants(inspect);
    for (const source of html) {
      const reply = await renderer.render({ kind: "html", source, inline: false });
      if (reply.kind !== "html") throw new Error(`${path}：无法检查 HTML 附件`);
      const { documentSchema } = await import("../../shared/markdown/schema");
      documentSchema.nodeFromJSON(reply.doc).descendants(inspect);
    }
    await resources.prefetchImages(
      references.filter((reference) => reference.image).map((reference) => reference.raw),
    );
    for (const reference of references) {
      if (/^(https?:|data:)/i.test(reference.raw)) {
        if (reference.image) await resources.image(reference.raw);
        continue;
      }
      const target = await native.resolve(path, reference.raw, reference.kind);
      if (target.status !== "resolved") {
        if (reference.embedded)
          throw new Error(`${path}：必要引用不存在或同名歧义：${reference.raw}`);
        issues.push({
          path,
          severity: "warning",
          message: `原格式保留未解析的普通链接：${reference.raw}`,
        });
        continue;
      }
      if (
        reference.embedded ||
        (!target.path.toLowerCase().endsWith(".md") && !isWhiteboardPath(target.path))
      )
        await collect(target.path);
      else ordinary.push({ from: path, raw: reference.raw, target: target.path });
    }
  }
  for (const [index, path] of initial.entries()) {
    report.progress(index, initial.length, path);
    await collect(path);
  }
  for (const link of ordinary)
    if (!visited.has(link.target))
      issues.push({
        path: link.from,
        severity: "warning",
        message: `原格式保留范围外的普通链接：${link.raw}`,
      });
  await native.seal();
  await native.directory("vault");
  for (const directory of native.snapshot.directories) await native.directory(`vault/${directory}`);
  for (const file of native.snapshot.files) await native.copy(file.path, `vault/${file.path}`);
  const remote: { url: string; path: string }[] = [];
  // 快照副本与原库分开放置；原文中的 URL 始终保持原字节。
  for (const download of resources.downloads) {
    const image = resources.images.get(download.path);
    if (!image) throw new Error("网络图片缺少已验证内容");
    const path = `export/remote/${posix.basename(download.path)}`;
    if (!remote.some((item) => item.path === path))
      await native.write(path, await native.readOutput(image.path));
    remote.push({ url: download.url, path });
  }
  const manifest = {
    version: 1,
    files: native.snapshot.files,
    directories: native.snapshot.directories,
    remote,
    issues,
  };
  await native.write(
    "export/manifest.json",
    new TextEncoder().encode(JSON.stringify(manifest, null, 2) + "\n"),
  );
  await native.retain([
    ...native.snapshot.files.map((file) => `vault/${file.path}`),
    ...new Set(remote.map((item) => item.path)),
    "export/manifest.json",
  ]);
  report.plan({
    files: [
      ...native.snapshot.files.map((file) => file.path),
      ...new Map(resources.downloads.map((item) => [item.path, item.url])).values(),
    ],
    bytes: native.snapshot.bytes + native.snapshot.resourceBytes,
    issues,
  });
  return { single: null, extension: "zip", name: "Noemori 原格式归档.zip", issues };
}
