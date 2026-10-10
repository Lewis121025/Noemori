import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { expect, it, onTestFinished, vi } from "vitest";
import { readConversationContent } from "../../../../modules/notes/packages/desktop/src/features/agent/main/content-reader";

vi.mock("electron", () => ({
  nativeImage: { createFromBuffer: () => ({ isEmpty: () => false }) },
}));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "noemori-content-reader-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  return { root, workspace };
}

it("PDF 返回真实字节，HTML 保留完整样式与源码，文本预览截断不截断保存内容", async () => {
  const { workspace } = await fixture();
  const pdf = await readFile(
    new URL("../../../notes/desktop/fixtures/preview.pdf", import.meta.url),
  );
  const html = "<!doctype html><style>h1 { color: teal }</style><h1>计划</h1>";
  const text = "资料".repeat(50_000);
  await writeFile(join(workspace, "报告.pdf"), pdf);
  await writeFile(join(workspace, "页面.html"), html);
  await writeFile(join(workspace, "资料.txt"), text);
  const document = await readConversationContent(workspace, "报告.pdf#page=2");
  expect(document.preview).toEqual({ type: "pdf", bytes: new Uint8Array(pdf) });
  expect(document.bytes).toEqual(new Uint8Array(pdf));
  expect((await readConversationContent(workspace, "页面.html")).preview).toEqual({
    type: "html",
    text: html,
  });
  const long = await readConversationContent(workspace, "资料.txt");
  expect(long.preview).toMatchObject({ type: "text", truncated: true });
  expect(new TextDecoder().decode(long.bytes)).toBe(text);
});

it("文件 URI 和编码文件名可读，跨目录、符号链接越界、目录和其他协议均不能读取", async () => {
  const { root, workspace } = await fixture();
  await writeFile(join(workspace, "图#稿?.html"), "<h1>原稿</h1>");
  await writeFile(join(root, "private.txt"), "私有资料");
  await symlink(join(root, "private.txt"), join(workspace, "escaped.txt"));
  expect((await readConversationContent(workspace, "图%23稿%3F.html")).name).toBe("图#稿?.html");
  for (const reference of [
    "../private.txt",
    join(root, "private.txt"),
    "escaped.txt",
    ".",
    "data:text/html,private",
    "https://user:secret@example.com/image.png",
  ])
    await expect(readConversationContent(workspace, reference)).rejects.toThrow();
});

it("外部资源只返回有界快照，不跟随重定向，超大响应在流读取时关闭", async () => {
  const { workspace } = await fixture();
  const server = createServer((request, response) => {
    if (request.url === "/redirect.png") {
      response.writeHead(302, { location: "/page.html" });
      response.end();
    } else if (request.url === "/large.pdf") {
      response.writeHead(200, { "content-length": String(25 * 1024 * 1024 + 1) });
      response.end("oversize");
    } else {
      response.writeHead(200);
      response.end("<h1>远端页面</h1>");
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务未监听");
  const base = `http://127.0.0.1:${address.port}`;
  expect((await readConversationContent(workspace, `${base}/page.html`)).preview).toEqual({
    type: "html",
    text: "<h1>远端页面</h1>",
  });
  await expect(readConversationContent(workspace, `${base}/redirect.png`)).rejects.toThrow();
  await expect(readConversationContent(workspace, `${base}/large.pdf`)).rejects.toThrow("25 MiB");
});
