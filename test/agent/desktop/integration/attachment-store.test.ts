import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { AttachmentStore } from "../../../../modules/notes/packages/desktop/src/features/agent/main/attachments";

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
