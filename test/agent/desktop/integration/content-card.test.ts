/** @vitest-environment jsdom */
import { flushSync, mount, unmount } from "svelte";
import { expect, it, vi } from "vitest";
import ContentCard from "../../../../modules/notes/packages/desktop/src/features/agent/renderer/ContentCard.svelte";
import { createAgentApiMock } from "../../../notes/desktop/fixtures/agent-api-mock";
import type { AttachmentUpload } from "../../../../modules/notes/packages/desktop/src/features/agent/shared/attachments";

it("保存内容提交可跨 IPC 克隆的原始快照，不把响应式代理传给主进程", async () => {
  const target = document.createElement("div");
  document.body.append(target);
  const bytes = new TextEncoder().encode("完整原文\n"),
    saved: AttachmentUpload[] = [];
  const api = {
    ...createAgentApiMock(),
    contentSave: vi.fn(async (file: AttachmentUpload) => {
      saved.push(structuredClone(file));
      return true;
    }),
  };
  const view = mount(ContentCard, {
    target,
    props: {
      api,
      source: {
        type: "inline",
        file: { name: "原文.txt", bytes },
        preview: { type: "text", text: "完整原文\n", truncated: false },
      },
    },
  });
  try {
    flushSync();
    target.querySelector<HTMLButtonElement>('[aria-label="保存文件"]')!.click();
    await vi.waitFor(() => {
      flushSync();
      expect(saved).toEqual([{ name: "原文.txt", bytes }]);
    });
    expect(target.querySelector('[role="alert"]')).toBeNull();
  } finally {
    await unmount(view);
    target.remove();
  }
});

it("关闭预览后迟到的文件响应不重建视图，不显示过期文件内容", async () => {
  const target = document.createElement("div");
  document.body.append(target);
  const pending = Promise.withResolvers<{
    name: string;
    bytes: Uint8Array;
    preview: { type: "text"; text: string; truncated: boolean };
  }>();
  const api = { ...createAgentApiMock(), contentPreview: vi.fn(() => pending.promise) };
  const view = mount(ContentCard, {
    target,
    props: { api, session: "甲", source: { type: "reference", reference: "资料.txt" } },
  });
  flushSync();
  await vi.waitFor(() => expect(api.contentPreview).toHaveBeenCalledWith("甲", "资料.txt"));
  await unmount(view);
  pending.resolve({
    name: "旧资料.txt",
    bytes: new Uint8Array(),
    preview: { type: "text", text: "旧响应", truncated: false },
  });
  await pending.promise;
  await Promise.resolve();
  expect(target.textContent).toBe("");
  target.remove();
});

it("放大与关闭移动同一预览节点，Esc 还原内嵌视图，不重新创建内容", async () => {
  const target = document.createElement("div");
  document.body.append(target);
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  const view = mount(ContentCard, {
    target,
    props: {
      source: {
        type: "inline",
        file: { name: "原文.txt", bytes: new Uint8Array() },
        preview: { type: "text", text: "保留阅读位置", truncated: false },
      },
    },
  });
  try {
    flushSync();
    const content = target.querySelector("pre")!;
    target.querySelector<HTMLButtonElement>('[aria-label="放大内容预览"]')!.click();
    flushSync();
    const dialog = target.querySelector<HTMLDialogElement>(".content-dialog")!;
    expect(dialog.open).toBe(true);
    expect(dialog.querySelector("pre")).toBe(content);
    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    flushSync();
    expect(dialog.open).toBe(false);
    expect(target.querySelector(".content-card pre")).toBe(content);
  } finally {
    await unmount(view);
    target.remove();
  }
});
