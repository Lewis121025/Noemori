import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import * as files from "node:fs/promises";
import * as crypto from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { AttachmentStore } from "../../../../modules/notes/packages/desktop/src/features/agent/main/attachments";
import { attachmentFilename } from "../../../../modules/notes/packages/desktop/src/features/agent/shared/attachments";

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
}));
vi.mock("node:crypto", async (original) => ({
  ...(await original<typeof import("node:crypto")>()),
}));
afterEach(() => vi.restoreAllMocks());

// Node 测试不提供 Electron 解码器；真实图片解码及损坏文件回滚由桌面端到端测试覆盖。
vi.mock("electron", () => ({
  nativeImage: { createFromBuffer: () => ({ isEmpty: () => false }) },
}));

const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
  "base64",
);

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "noemori-attachment-store-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  return { directory, store: new AttachmentStore(join(directory, "app")) };
}

it("选择文件后冻结原始内容，图片交付真实字节，普通文件可预览且分叉不依赖来源", async () => {
  const { directory, store } = await fixture();
  const source = join(directory, "资料.txt"),
    image = join(directory, "图.png");
  await writeFile(source, "用户选中的原文");
  await writeFile(image, png);
  const files = await store.import(first, [source, image]);
  expect(await readdir(store.directory(first))).toEqual([]);
  await store.publish(first, files);
  expect(await readdir(store.directory(first))).toHaveLength(2);
  await writeFile(source, "后续改动");
  expect(await store.preview(first, files[0]!)).toMatchObject({
    type: "text",
    text: "用户选中的原文",
    truncated: false,
  });
  expect(await store.images(first, files)).toEqual([
    { format: "png", data: png.toString("base64") },
  ]);
  await store.copy(first, second, files);
  await store.remove(first);
  expect(await store.preview(second, files[0]!)).toMatchObject({ text: "用户选中的原文" });
  expect(await store.images(second, files)).toHaveLength(1);
  expect(await readFile(source, "utf8")).toBe("后续改动");
});

it("中途失败整批回滚；附件归属、内容损坏和符号链接不能被绕过", async () => {
  const { directory, store } = await fixture();
  const source = join(directory, "资料.txt");
  await writeFile(source, "原文");
  await expect(store.import(first, [source, join(directory, "不存在")])).rejects.toThrow();
  expect(await readdir(store.directory(first))).toEqual([]);
  const [file] = await store.import(first, [source]);
  await expect(store.preview(second, file!)).rejects.toThrow();
  const path = store.path(first, file!);
  await rm(path);
  await symlink(source, path);
  await expect(store.preview(first, file!)).rejects.toThrow();
  await rm(path);
  await writeFile(path, "损坏");
  await expect(store.preview(first, file!)).rejects.toThrow("内容已变化");
});

it("撤销无引用附件同时清理私有副本和工具可读副本", async () => {
  const { store } = await fixture();
  const files = await store.import(first, [
    { name: "资料.txt", bytes: new TextEncoder().encode("资料") },
  ]);
  await store.publish(first, files);
  await store.discard(first, files);
  expect(await readdir(store.directory(first))).toEqual([]);
  await expect(readFile(store.path(first, files[0]!))).rejects.toThrow();
});

it("独占导入发生身份冲突时保留既有附件，只回滚本批实际创建的副本", async () => {
  const { store } = await fixture();
  const original = crypto.randomUUID;
  const identity = vi.spyOn(crypto, "randomUUID").mockReturnValueOnce(first);
  const [existing] = await store.import(first, [
    { name: "资料.txt", bytes: Buffer.from("既有内容") },
  ]);
  if (!existing) throw new Error("测试附件缺失");
  identity.mockImplementationOnce(original).mockReturnValueOnce(first);

  await expect(
    store.import(first, [
      { name: "新增.txt", bytes: Buffer.from("本批内容") },
      { name: "资料.txt", bytes: Buffer.from("冲突内容") },
    ]),
  ).rejects.toMatchObject({ code: "EEXIST" });
  expect(await store.preview(first, existing)).toMatchObject({ text: "既有内容" });
  expect(await readdir(join(store.path(first, existing), ".."))).toEqual([
    attachmentFilename(existing),
  ]);
});

it("检查与发布之间出现目标文件时拒绝覆盖，回滚不删除其他操作创建的文件", async () => {
  const { store } = await fixture();
  const imported = await store.import(first, [
    { name: "一.txt", bytes: Buffer.from("一") },
    { name: "二.txt", bytes: Buffer.from("二") },
  ]);
  const secondFile = imported[1];
  if (!secondFile) throw new Error("测试附件缺失");
  const copy = files.copyFile;
  vi.spyOn(files, "copyFile")
    .mockImplementationOnce(copy)
    .mockImplementationOnce(async (...args) => {
      await writeFile(args[1], "另一操作的文件", { flag: "wx" });
      await copy(...args);
    });

  await expect(store.publish(first, imported)).rejects.toMatchObject({ code: "EEXIST" });
  const target = join(store.directory(first), attachmentFilename(secondFile));
  expect(await readFile(target, "utf8")).toBe("另一操作的文件");
  expect(await readdir(store.directory(first))).toEqual([attachmentFilename(secondFile)]);
  expect(await store.preview(first, secondFile)).toMatchObject({ text: "二" });
});

it("分叉遇到目标已有附件时保留目标内容，撤销已复制前缀及其发布副本", async () => {
  const { store } = await fixture();
  const imported = await store.import(first, [
    { name: "一.txt", bytes: Buffer.from("一") },
    { name: "二.txt", bytes: Buffer.from("二") },
  ]);
  const secondFile = imported[1];
  if (!secondFile) throw new Error("测试附件缺失");
  await store.publish(first, imported);
  await store.prepare(second);
  const existing = store.path(second, secondFile);
  await writeFile(existing, "目标原有内容");

  await expect(store.copy(first, second, imported)).rejects.toMatchObject({ code: "EEXIST" });
  expect(await readFile(existing, "utf8")).toBe("目标原有内容");
  expect(await readdir(join(existing, ".."))).toEqual([attachmentFilename(secondFile)]);
  expect(await readdir(store.directory(second))).toEqual([]);
  expect(await store.preview(first, secondFile)).toMatchObject({ text: "二" });
});

it.each([false, true])(
  "部分写入失败后关闭句柄并回滚，关闭也失败=%s 时保留两处原因",
  async (closeFails) => {
    const { store } = await fixture();
    const open = files.open;
    const failure = new Error("附件写入中断");
    const cleanup = new Error("附件句柄关闭失败");
    let closed = false;
    vi.spyOn(files, "open").mockImplementationOnce(async (...args) => {
      const handle = await open(...args);
      const write = handle.writeFile.bind(handle);
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "writeFile").mockImplementationOnce(async (data) => {
        await write(data);
        throw failure;
      });
      vi.spyOn(handle, "close").mockImplementationOnce(async () => {
        await close();
        closed = true;
        if (closeFails) throw cleanup;
      });
      return handle;
    });

    const importing = store.import(first, [{ name: "资料.txt", bytes: Buffer.from("部分内容") }]);
    if (closeFails) await expect(importing).rejects.toMatchObject({ errors: [failure, cleanup] });
    else await expect(importing).rejects.toBe(failure);
    expect(closed).toBe(true);
    expect(await readdir(join(store.directory(first), "../../owned", first))).toEqual([]);
  },
);

it("分叉回滚失败同时保留复制和清理错误，并继续清理其他已创建副本", async () => {
  const { store } = await fixture();
  const imported = await store.import(first, [
    { name: "一.txt", bytes: Buffer.from("一") },
    { name: "二.txt", bytes: Buffer.from("二") },
  ]);
  const firstFile = imported[0];
  if (!firstFile) throw new Error("测试附件缺失");
  await store.publish(first, imported);
  const copy = files.copyFile;
  const failure = new Error("复制中断");
  const cleanup = new Error("回滚文件无法删除");
  vi.spyOn(files, "copyFile")
    .mockImplementationOnce(copy)
    .mockImplementationOnce(copy)
    .mockRejectedValueOnce(failure);
  const remove = files.rm;
  vi.spyOn(files, "rm").mockImplementation(async (...args) => {
    if (args[0] === store.path(second, firstFile)) throw cleanup;
    return remove(...args);
  });

  await expect(store.copy(first, second, imported)).rejects.toMatchObject({
    message: "附件分叉失败且未能完整回滚",
    errors: [failure, cleanup],
  });
  expect(await readFile(store.path(second, firstFile), "utf8")).toBe("一");
  expect(await readdir(store.directory(second))).toEqual([]);
});

it.each([false, true])(
  "读取附件失败后关闭句柄，关闭也失败=%s 时保留两处原因",
  async (closeFails) => {
    const { store } = await fixture();
    const [file] = await store.import(first, [{ name: "资料.txt", bytes: Buffer.from("原文") }]);
    if (!file) throw new Error("测试附件缺失");
    const open = files.open;
    const failure = new Error("附件读取中断");
    const cleanup = new Error("附件句柄关闭失败");
    let closed = false;
    vi.spyOn(files, "open").mockImplementationOnce(async (...args) => {
      const handle = await open(...args);
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "read").mockRejectedValueOnce(failure);
      vi.spyOn(handle, "close").mockImplementationOnce(async () => {
        await close();
        closed = true;
        if (closeFails) throw cleanup;
      });
      return handle;
    });

    const previewing = store.preview(first, file);
    if (closeFails) await expect(previewing).rejects.toMatchObject({ errors: [failure, cleanup] });
    else await expect(previewing).rejects.toBe(failure);
    expect(closed).toBe(true);
    expect(await store.preview(first, file)).toMatchObject({ text: "原文" });
  },
);
