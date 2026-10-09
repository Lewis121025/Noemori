/** @vitest-environment jsdom */
import { flushSync, mount, unmount } from "svelte";
import { expect, it, onTestFinished, vi } from "vitest";
import AgentPanel from "../../../../modules/notes/packages/desktop/src/features/agent/renderer/AgentPanel.svelte";
import type { AgentConversation } from "../../../../modules/notes/packages/desktop/src/features/agent/shared/api";
import type { AgentReference } from "../../../../modules/notes/packages/desktop/src/features/agent/shared/references";
import { newProviderModel } from "../../../../modules/notes/packages/desktop/src/features/agent/shared/providers";
import { createAgentApiMock } from "../../../notes/desktop/fixtures/agent-api-mock";

const quote: AgentReference = {
  id: "quoted",
  text: "原文😀\n第二行",
  source: { root: "/vault", path: "资料/文章.md", offset: 0, sourceText: "原文😀\n第二行" },
};
async function fixture() {
  const item: AgentConversation = {
    id: "conversation",
    title: "引用对话",
    workspace: null,
    model: "fixture",
    modelSelection: { providerId: "provider", modelId: "fixture" },
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    origin: null,
    article: null,
    draft: "原有草稿",
    storageError: null,
    revision: 0,
    closed: false,
    run: null,
    turns: [],
    messages: [],
    terminals: [],
    approvals: [],
    ui: {
      status: "idle",
      generation: 0,
      call: null,
      error: null,
      control: null,
      connections: [],
      receipts: [],
    },
    browser: { status: "idle", tabs: [], receipts: [], error: null },
  };
  const api = createAgentApiMock();
  api.list = vi.fn(async () => ({ items: [{ ...item, status: null }], issues: [] }));
  api.snapshot = vi.fn(async () => structuredClone(item));
  api.saveDraft = vi.fn(async (_id, text, references) => {
    item.draft = text;
    item.draftReferences = references ?? [];
  });
  api.providersGet = vi.fn(async () => ({
    providers: [
      {
        id: "provider",
        name: "连接",
        protocol: "openai-chat" as const,
        address: { type: "base_url" as const, url: "https://example.com/v1" },
        authentication: { type: "none" as const, configured: false, name: "", region: "" },
        models: [newProviderModel("fixture")],
      },
    ],
  }));
  const target = document.createElement("div");
  document.body.append(target);
  const panel = mount(AgentPanel, {
    target,
    props: { api, close: () => {}, openLink: async () => {} },
  });
  onTestFinished(async () => {
    await unmount(panel);
    target.remove();
  });
  await vi.waitFor(() => {
    flushSync();
    expect(target.querySelector("h1")?.textContent).toBe(item.title);
    expect(target.querySelector<HTMLButtonElement>('[aria-label="发送"]')?.disabled).toBe(false);
  });
  return { item, api, target, panel };
}

it("引用随当前草稿保存且不覆盖文字，重复添加与移除不创建任务", async () => {
  const { api, item, target, panel } = await fixture();
  await panel.addSelectedReference(quote);
  expect(api.saveDraft).toHaveBeenCalledWith(item.id, "原有草稿", [quote]);
  expect(target.querySelector("textarea")?.value).toBe("原有草稿");
  await panel.addSelectedReference({ ...quote, id: "duplicate" });
  expect(target.querySelectorAll('[aria-label="引用内容"] li')).toHaveLength(1);
  target.querySelector<HTMLButtonElement>('[aria-label="移除引用：文章.md"]')!.click();
  await panel.flushDraft();
  expect(api.saveDraft).toHaveBeenLastCalledWith(item.id, "原有草稿");
  expect(item.draftReferences).toEqual([]);
});

it("发送接受失败保留文字和引用，重试传递同一份来源", async () => {
  const { api, target, panel } = await fixture();
  api.start = vi.fn().mockRejectedValueOnce(new Error("发送未被接受")).mockResolvedValue("run");
  await panel.addSelectedReference(quote);
  target.querySelector<HTMLButtonElement>('[aria-label="发送"]')!.click();
  await vi.waitFor(() => {
    flushSync();
    expect(target.textContent).toContain("发送未被接受");
  });
  expect(target.querySelector("textarea")?.value).toBe("原有草稿");
  expect(target.querySelector('[aria-label="预览引用：文章.md"]')).not.toBeNull();
  target.querySelector<HTMLButtonElement>('[aria-label="发送"]')!.click();
  await vi.waitFor(() => expect(api.start).toHaveBeenCalledTimes(2));
  expect(api.start).toHaveBeenLastCalledWith("conversation", "原有草稿", [quote]);
});

it("拖入普通选中文字成为引用卡片，落点反馈退出后清除且不改草稿", async () => {
  const { target, api, item } = await fixture();
  const form = target.querySelector("form.composer")!;
  const transfer = {
    types: ["text/plain"],
    files: [],
    dropEffect: "none",
    getData: (type: string) => (type === "text/plain" ? "从别处选中的文字" : ""),
  };
  const enter = new Event("dragenter", { bubbles: true, cancelable: true });
  Object.defineProperty(enter, "dataTransfer", { value: transfer });
  form.dispatchEvent(enter);
  flushSync();
  expect(enter.defaultPrevented).toBe(true);
  expect(target.querySelector(".reference-drop")?.textContent).toContain("松开即可");
  const drop = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(drop, "dataTransfer", { value: transfer });
  form.dispatchEvent(drop);
  await vi.waitFor(() => {
    flushSync();
    expect(api.saveDraft, target.textContent ?? "").toHaveBeenCalled();
  });
  expect(item.draftReferences?.[0]?.text).toBe("从别处选中的文字");
  expect(item.draftReferences?.[0]?.source).toBeNull();
  expect(target.querySelector("textarea")?.value).toBe("原有草稿");
  expect(target.querySelector(".reference-drop")).toBeNull();
});

it("空工作区添加引用期间切换对话，迟到的新建结果只保存引用，不抢回对话与草稿", async () => {
  const { api, item, target, panel } = await fixture();
  await panel.openArticleConversation(null, { root: "/vault", path: "未关联.md" });
  const created: AgentConversation = {
    ...item,
    id: "new-conversation",
    title: "新对话",
    draft: "",
  };
  const gate = Promise.withResolvers<AgentConversation>();
  api.create = vi.fn(() => gate.promise);
  api.saveDraft = vi.fn(async (id, text, references) => {
    const record = id === created.id ? created : item;
    record.draft = text;
    record.draftReferences = references ?? [];
  });
  const pending = panel.addSelectedReference(quote);
  onTestFinished(async () => {
    gate.resolve(created);
    await pending;
  });
  await vi.waitFor(() => expect(api.create).toHaveBeenCalledOnce());
  await panel.selectConversation(item.id);
  gate.resolve(created);
  await pending;
  flushSync();
  expect(api.saveDraft).toHaveBeenCalledWith(created.id, "", [quote]);
  expect(created.draftReferences).toEqual([quote]);
  expect(target.querySelector("h1")?.textContent).toBe(item.title);
  expect(target.querySelector("textarea")?.value).toBe("原有草稿");
  expect(item.draftReferences).toBeUndefined();
});
