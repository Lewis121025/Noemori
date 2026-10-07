import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserEngine } from "../../../../modules/agent/web-runtime/dist/browser/engine.js";
import { BrowserFiles } from "../../../../modules/agent/web-runtime/dist/browser/files.js";

test("浏览器上下文关闭失败后仍回收文件任务，并向宿主报告失败", async () => {
  let filesClosed = false;
  const engine = new BrowserEngine(
    {
      pages: () => [],
      on: () => {},
      close: async () => {
        throw new Error("上下文关闭失败");
      },
    },
    {
      workspace: "/",
      download_directory: "/",
      max_pages: 8,
      max_chars: 20000,
      max_elements: 100,
      max_download_bytes: 1024,
    },
  );
  engine.files.close = async () => {
    filesClosed = true;
    throw new Error("文件任务清理失败");
  };
  await assert.rejects(
    () => engine.close(),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(
        error.errors.map((failure) => failure.message),
        ["上下文关闭失败", "文件任务清理失败"],
      );
      return true;
    },
  );
  assert.equal(filesClosed, true);
  assert.equal(
    (await engine.execute({ action: "tabs" }, new AbortController().signal, 1000)).outcome,
    "not_executed",
  );
});

test("下载取消失败时仍等待文件任务结算，关闭不能留下进行中记录", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "noemori-browser-lifecycle-"));
  let started;
  let finish;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const released = new Promise((resolve) => {
    finish = resolve;
  });
  t.after(async () => {
    await released;
    await rm(root, { recursive: true, force: true });
  });
  const files = new BrowserFiles({
    workspace: root,
    download_directory: join(root, "downloads"),
    max_download_bytes: 1024,
  });
  files.receive({
    suggestedFilename: () => "receipt.txt",
    saveAs: async () => {
      started();
      await released;
      throw new Error("下载流关闭");
    },
    cancel: async () => {
      setTimeout(finish, 25);
      throw new Error("下载取消失败");
    },
  });
  await ready;
  await assert.rejects(() => files.close(), /下载取消失败/);
  assert.equal(files.states()[0].status, "failed");
  assert.equal(files.states()[0].error, "下载流关闭");
});
