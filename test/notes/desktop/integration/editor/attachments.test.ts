/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { history, undo, redo } from "prosemirror-history";
import { createAttachmentEditing } from "@reader/renderer/editor/attachments/attachments";
import { createMarkdownSession } from "@reader/renderer/markdown/source-session";
import { parseMarkdown } from "@reader/renderer/markdown/parse";
import { MAX_ATTACHMENT_BYTES, type ImportedAttachment } from "@reader/shared/attachments";

const views: EditorView[] = [];
const source = "\uFEFF前文 __保留__\r\n\r\n正文\r\n\r\n后文 _原样_";
function file(name: string) {
  const bytes = new Uint8Array([0, 255, 13, 10]);
  return Object.assign(new File([bytes], name), { arrayBuffer: vi.fn(async () => bytes.buffer) });
}
function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error("Promise 尚未初始化"); };
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function start(text = source) {
  const session = createMarkdownSession(text);
  const importer = vi.fn(async (name: string, _bytes: Uint8Array): Promise<ImportedAttachment> => ({ path: `资料/attachments/${name}`, warning: null }));
  const progress = vi.fn();
  const report = vi.fn();
  const editing = createAttachmentEditing({ import: importer, progress, report });
  const host = document.createElement("div");
  document.body.append(host);
  const view = new EditorView(host, {
    state: EditorState.create({ doc: session.doc, plugins: [history(), editing.plugin] }),
    dispatchTransaction(tr) { session.track(tr); view.updateState(view.state.apply(tr)); },
  });
  views.push(view);
  let pos = 1;
  view.state.doc.descendants((node, at) => { if (node.isText && node.text === "正文") pos = at + 2; });
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
  return { view, editing, importer, progress, report, save: () => new TextDecoder("utf8", { ignoreBOM: true }).decode(session.snapshot(view.state.doc).bytes) };
}
afterEach(() => {
  for (const view of views.splice(0)) if (!view.isDestroyed) view.destroy();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it("在段落中间插入白板会建立块级引用，撤销不删除独立文件", async () => {
  const { view, editing, importer, save } = start();
  const original = view.state.doc;
  expect(editing.prepare(view)).toBe(true);
  await editing.insertFiles(view, [file("白板.noemoriboard")]);
  expect(importer).toHaveBeenCalledOnce();
  expect(save()).toContain("![[资料/attachments/白板.noemoriboard]]");
  expect(parseMarkdown(save().slice(1)).eq(view.state.doc)).toBe(true);
  expect(undo(view.state, view.dispatch)).toBe(true);
  expect(view.state.doc.eq(original)).toBe(true);
});

it("阅读态不启动附件导入；已开始的导入在切换后保留文件并报告未插入引用", async () => {
  const { view, editing, importer, report, save } = start();
  const original = save();
  view.setProps({ editable: () => false });
  expect(editing.prepare(view)).toBe(false);
  await editing.insertFiles(view, [file("blocked.png")]);
  expect(importer).not.toHaveBeenCalled();
  view.setProps({ editable: () => true });
  const pending = deferred<ImportedAttachment>();
  importer.mockReturnValueOnce(pending.promise);
  expect(editing.prepare(view)).toBe(true);
  const request = editing.insertFiles(view, [file("pending.png")]);
  await vi.waitFor(() => expect(importer).toHaveBeenCalledOnce());
  view.setProps({ editable: () => false });
  pending.resolve({ path: "资料/attachments/pending.png", warning: null });
  await request;
  expect(save()).toBe(original);
  expect(report).toHaveBeenCalledWith(expect.stringContaining("尚未插入引用"));
  expect(importer).toHaveBeenCalledOnce();
});

it("图片、PDF 和普通文件使用可往返的相对引用，撤销保留字节与前后源码", async () => {
  const { view, editing, importer, save } = start();
  const original = view.state.doc;
  expect(editing.prepare(view)).toBe(true);
  await editing.insertFiles(view, [file("图片 #1.png"), file("报告.pdf"), file("a (b)%.zip")]);
  expect(importer).toHaveBeenCalledTimes(3);
  expect(importer.mock.calls[0]?.[1]).toEqual(new Uint8Array([0, 255, 13, 10]));
  const saved = save();
  expect(saved.startsWith("\uFEFF前文 __保留__\r\n\r\n正文")).toBe(true);
  expect(saved.endsWith("\r\n\r\n后文 _原样_")).toBe(true);
  expect(saved).toContain("./attachments/%E5%9B%BE%E7%89%87%20%231.png");
  expect(saved).toContain("./attachments/a%20%28b%29%25.zip");
  expect(parseMarkdown(saved.slice(1)).eq(view.state.doc)).toBe(true);
  for (let count = 0; count < 3; count++) expect(undo(view.state, view.dispatch)).toBe(true);
  expect(view.state.doc.eq(original)).toBe(true);
  expect(save()).toBe(source);
  for (let count = 0; count < 3; count++) expect(redo(view.state, view.dispatch)).toBe(true);
  expect(save()).toBe(saved);
  expect(importer).toHaveBeenCalledTimes(3);
});

it("等待导入时继续输入并移动光标，返回结果使用映射后的位置且不夺走新选区", async () => {
  const { view, editing, importer, save } = start();
  const pending = deferred<ImportedAttachment>();
  importer.mockReturnValueOnce(pending.promise);
  editing.prepare(view);
  const request = editing.insertFiles(view, [file("x.zip")]);
  await vi.waitFor(() => expect(importer).toHaveBeenCalledOnce());
  view.dispatch(view.state.tr.insertText("继续"));
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 3)));
  const selection = view.state.selection;
  pending.resolve({ path: "资料/attachments/x.zip", warning: null });
  await request;
  expect(save()).toContain("正文继续[x.zip](./attachments/x.zip)");
  expect(view.state.selection.eq(selection)).toBe(true);
  undo(view.state, view.dispatch);
  expect(save()).toBe(source.replace("正文", "正文继续"));
});

it("插入点在字节读取期间被删除时不写盘", async () => {
  const { view, editing, importer, report } = start();
  const bytes = deferred<ArrayBuffer>();
  const attachment = file("x.png");
  attachment.arrayBuffer.mockReturnValueOnce(bytes.promise);
  editing.prepare(view);
  const request = editing.insertFiles(view, [attachment]);
  const from = view.state.selection.$from.before();
  const to = view.state.selection.$from.after();
  view.dispatch(view.state.tr.delete(from, to));
  bytes.resolve(new ArrayBuffer(1));
  await request;
  expect(importer).not.toHaveBeenCalled();
  expect(report).toHaveBeenCalledWith(expect.stringContaining("附件未导入"));
});

it.each(["删除位置", "关闭文档"])("提交后%s不会误插；报告已存在附件路径", async (action) => {
  const { view, editing, importer, report, save } = start();
  const pending = deferred<ImportedAttachment>();
  importer.mockReturnValueOnce(pending.promise);
  editing.prepare(view);
  const request = editing.insertFiles(view, [file("x.png"), file("later.png")]);
  await vi.waitFor(() => expect(importer).toHaveBeenCalledOnce());
  if (action === "关闭文档") view.destroy();
  else view.dispatch(view.state.tr.delete(view.state.selection.$from.before(), view.state.selection.$from.after()));
  const current = save();
  pending.resolve({ path: "资料/attachments/x.png", warning: null });
  await request;
  expect(save()).toBe(current);
  expect(importer).toHaveBeenCalledOnce();
  expect(report).toHaveBeenCalledWith(expect.stringContaining("附件已导入 资料/attachments/x.png"));
});

it("批次中途失败仅重试剩余文件，已完成的附件与警告均保留", async () => {
  const { view, editing, importer, progress, report, save } = start();
  importer.mockResolvedValueOnce({ path: "资料/attachments/a.zip", warning: "索引待重试" });
  importer.mockRejectedValueOnce(new Error("磁盘已满"));
  editing.prepare(view);
  await editing.insertFiles(view, [file("a.zip"), file("b.zip"), file("c.zip")]);
  expect(progress).toHaveBeenLastCalledWith({ status: "failed", message: expect.stringContaining("磁盘已满") });
  expect(report).toHaveBeenCalledWith(expect.stringContaining("索引待重试"));
  expect(save()).toContain("a.zip");
  expect(save()).not.toContain("b.zip");
  await editing.retry(view);
  expect(importer.mock.calls.map((call) => call[0])).toEqual(["a.zip", "b.zip", "b.zip", "c.zip"]);
  expect(save()).toContain("[a.zip](./attachments/a.zip) [b.zip](./attachments/b.zip) [c.zip](./attachments/c.zip)");
  expect(progress).toHaveBeenLastCalledWith(null);
});

it("大文件在读取前拒绝，组词和代码块内不发起导入", async () => {
  const { view, editing, importer, progress } = start();
  const attachment = file("large.pdf");
  Object.defineProperty(attachment, "size", { value: MAX_ATTACHMENT_BYTES + 1 });
  editing.prepare(view);
  await editing.insertFiles(view, [attachment]);
  expect(attachment.arrayBuffer).not.toHaveBeenCalled();
  expect(importer).not.toHaveBeenCalled();
  expect(progress).toHaveBeenLastCalledWith({ status: "failed", message: expect.stringContaining("64 MiB") });
  editing.dismiss(view);
  vi.spyOn(view, "composing", "get").mockReturnValue(true);
  expect(editing.prepare(view)).toBe(false);
  const code = start("```\ncode\n```\n");
  expect(code.editing.prepare(code.view)).toBe(false);
});

it("导入完成时仍在组词，等原生组词结束再插入，且关闭文档不会留下等待", async () => {
  const { view, editing, importer, save } = start();
  const pending = deferred<ImportedAttachment>();
  importer.mockReturnValueOnce(pending.promise);
  editing.prepare(view);
  const request = editing.insertFiles(view, [file("x.zip")]);
  await vi.waitFor(() => expect(importer).toHaveBeenCalledOnce());
  const composing = vi.spyOn(view, "composing", "get").mockReturnValue(true);
  pending.resolve({ path: "资料/attachments/x.zip", warning: null });
  await Promise.resolve();
  expect(save()).toBe(source);
  composing.mockReturnValue(false);
  view.dom.dispatchEvent(new Event("compositionend"));
  await request;
  expect(save()).toContain("x.zip");
});
