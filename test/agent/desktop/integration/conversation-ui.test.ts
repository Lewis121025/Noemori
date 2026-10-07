/** @vitest-environment jsdom */
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import AgentPanel from "../../../../modules/notes/packages/desktop/src/features/agent/renderer/AgentPanel.svelte";
import type {
  AgentApi,
  AgentConversation,
} from "../../../../modules/notes/packages/desktop/src/features/agent/shared/api";
import { createAgentApiMock } from "../../../notes/desktop/fixtures/agent-api-mock";

let target: HTMLDivElement;
let panel: AgentPanel;
let api: AgentApi;
let records: AgentConversation[];
let notify: (id: string) => void;

function conversation(id: string): AgentConversation {
  return {
    id,
    title: `项目${id}`,
    workspace: `/workspace/${id}`,
    model: "fixture",
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    origin: null,
    article: null,
    draft: `草稿${id}`,
    storageError: null,
    revision: 0,
    closed: false,
    run: null,
    turns: [],
    messages: [],
    terminals: [],
    approvals: [],
    browser: { status: "idle", tabs: [], receipts: [], error: null },
  };
}
function button(label: string, scope: ParentNode = target): HTMLButtonElement {
  const result = [...scope.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === label || node.getAttribute("aria-label") === label,
  );
  if (!result) throw new Error(`缺少按钮：${label}`);
  return result;
}
function select(id: string): void {
  target.querySelector<HTMLButtonElement>(`.conversation-item[title^="项目${id}"]`)!.click();
}
function input(value: string): void {
  const field = target.querySelector("textarea")!;
  field.value = value;
  field.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
}
async function selected(id: string): Promise<void> {
  await vi.waitFor(() => {
    flushSync();
    expect(target.querySelector("h1")?.textContent).toBe(`项目${id}`);
  });
}
async function manage(action: string): Promise<HTMLDialogElement> {
  button(action).click();
  await vi.waitFor(() => {
    flushSync();
    expect(target.querySelector(".conversation-action-dialog[open]")).not.toBeNull();
  });
  return target.querySelector(".conversation-action-dialog")!;
}
function submit(dialog: HTMLDialogElement): void {
  dialog
    .querySelector("form")!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

beforeEach(async () => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  records = [conversation("甲"), conversation("乙"), conversation("丙")];
  api = {
    ...createAgentApiMock(),
    list: vi.fn(async () => ({
      items: records.map((item) => ({ ...item, status: item.run?.status ?? null })),
      issues: [],
    })),
    snapshot: vi.fn(async (id) => structuredClone(records.find((item) => item.id === id)!)),
    saveDraft: vi.fn(async (id, draft) => {
      records.find((item) => item.id === id)!.draft = draft;
    }),
    rename: vi.fn(async (id, title) => {
      records.find((item) => item.id === id)!.title = title;
    }),
    archive: vi.fn(async (id, archived) => {
      records.find((item) => item.id === id)!.archived = archived;
    }),
    remove: vi.fn(async (id) => {
      records = records.filter((item) => item.id !== id);
    }),
    subscribe: (callback) => {
      notify = callback;
      return () => {};
    },
  };
  target = document.createElement("div");
  document.body.append(target);
  panel = mount(AgentPanel, { target, props: { api, close: () => {}, openLink: async () => {} } });
  flushSync();
  await selected("甲");
});

afterEach(async () => {
  await unmount(panel);
  target.remove();
  vi.restoreAllMocks();
});

it("切换前保存草稿，保存失败保留当前会话与输入，重试后每条草稿相互独立", async () => {
  input("尚未发送的项目需求");
  vi.mocked(api.saveDraft).mockRejectedValueOnce(new Error("磁盘暂时不可写"));
  select("乙");
  await vi.waitFor(() => expect(target.textContent).toContain("磁盘暂时不可写"));
  expect(target.querySelector("h1")?.textContent).toBe("项目甲");
  expect(target.querySelector("textarea")?.value).toBe("尚未发送的项目需求");
  select("乙");
  await selected("乙");
  expect(target.querySelector("textarea")?.value).toBe("草稿乙");
  select("甲");
  await selected("甲");
  expect(target.querySelector("textarea")?.value).toBe("尚未发送的项目需求");
});

it("快速切换时，较早的慢请求不能覆盖最后选择的会话和草稿", async () => {
  const waiting = Promise.withResolvers<AgentConversation>();
  vi.mocked(api.snapshot).mockImplementationOnce(() => waiting.promise);
  select("乙");
  await vi.waitFor(() => expect(api.snapshot).toHaveBeenCalledWith("乙"));
  select("丙");
  await selected("丙");
  waiting.resolve(conversation("乙"));
  await waiting.promise;
  flushSync();
  expect(target.querySelector("h1")?.textContent).toBe("项目丙");
  expect(target.querySelector("textarea")?.value).toBe("草稿丙");
});

it("较早的通知快照不能把新回复覆盖回旧内容", async () => {
  const old = Promise.withResolvers<AgentConversation>();
  vi.mocked(api.snapshot).mockImplementationOnce(() => old.promise);
  notify("甲");
  await vi.waitFor(() => expect(api.snapshot).toHaveBeenCalledTimes(2));
  const latest = records[0]!;
  latest.revision = 2;
  latest.messages = [{ role: "assistant", content: [{ type: "text", value: "最新回复" }] }];
  notify("甲");
  await vi.waitFor(() => expect(target.textContent).toContain("最新回复"));
  old.resolve(conversation("甲"));
  await old.promise;
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync();
  expect(target.textContent).toContain("最新回复");
});

it("发送接受期间切换会话，不把已发送文本重新保存为草稿", async () => {
  const accepted = Promise.withResolvers<string>();
  api.start = vi.fn(async (id) => {
    const result = await accepted.promise;
    records.find((item) => item.id === id)!.draft = "";
    return result;
  });
  input("执行一次任务");
  button("发送").click();
  await vi.waitFor(() => expect(api.start).toHaveBeenCalledWith("甲", "执行一次任务"));
  select("乙");
  accepted.resolve("run");
  await selected("乙");
  select("甲");
  await selected("甲");
  expect(target.querySelector("textarea")?.value).toBe("");
});

it("重命名、归档、恢复、删除都有明确目标，取消删除不改变记录", async () => {
  const rename = await manage("重命名对话");
  const name = rename.querySelector("input")!;
  name.value = "明确的名称";
  name.dispatchEvent(new Event("input", { bubbles: true }));
  submit(rename);
  await vi.waitFor(() => expect(target.querySelector("h1")?.textContent).toBe("明确的名称"));
  submit(await manage("归档对话"));
  await selected("乙");
  button("已归档").click();
  flushSync();
  target.querySelector<HTMLButtonElement>(".conversation-item")!.click();
  await vi.waitFor(() => expect(target.textContent).toContain("此对话已归档"));
  expect(target.querySelector("textarea")).toBeNull();
  button("恢复对话").click();
  await vi.waitFor(() => expect(target.querySelector("textarea")).not.toBeNull());
  const remove = await manage("删除对话");
  button("取消", remove).click();
  expect(api.remove).not.toHaveBeenCalled();
  submit(await manage("删除对话"));
  await selected("乙");
  expect(records.some((item) => item.id === "甲")).toBe(false);
});

it("停止中保持按钮禁用，结算后才能继续；继续保留当前未发送草稿", async () => {
  const item = records[0]!;
  item.run = { id: "original-run", status: "running", error: null, model_calls: 1 };
  notify(item.id);
  await vi.waitFor(() => {
    flushSync();
    button("停止生成");
  });
  const settled = Promise.withResolvers<void>();
  api.cancel = vi.fn(async () => {
    await settled.promise;
    item.run!.status = "cancelled";
  });
  api.resume = vi.fn(async () => {
    item.run = { id: "continued-run", status: "running", error: null, model_calls: 0 };
    return item.run.id;
  });
  input("不应被继续按钮丢掉的草稿");
  button("停止生成").click();
  flushSync();
  expect(button("正在停止…").disabled).toBe(true);
  expect(api.cancel).toHaveBeenCalledWith(item.id, "original-run");
  settled.resolve();
  await vi.waitFor(() => {
    flushSync();
    button("继续任务");
  });
  button("继续任务").click();
  await vi.waitFor(() => expect(api.resume).toHaveBeenCalledWith(item.id, "original-run"));
  expect(target.querySelector("textarea")?.value).toBe("不应被继续按钮丢掉的草稿");
  expect(item.draft).toBe("不应被继续按钮丢掉的草稿");
});

it("历史轮次分叉先确认，取消不创建；分叉后可导航回来源轮次", async () => {
  const item = records[0]!;
  item.messages = [
    { role: "user", content: [{ type: "text", value: "第一轮问题" }] },
    { role: "assistant", content: [{ type: "text", value: "第一轮回答" }] },
  ];
  item.run = { id: "turn-one", status: "completed", error: null, model_calls: 1 };
  item.turns = [{ run: item.run, message_start: 0, message_end: 2 }];
  api.fork = vi.fn(async (id, request) => {
    const source = records.find((record) => record.id === id)!;
    const child = {
      ...structuredClone(source),
      id: "branch",
      title: request.title,
      draft: "",
      origin: { conversationId: id, title: source.title, turnId: request.afterTurnId },
    };
    records.unshift(child);
    return child;
  });
  notify(item.id);
  await vi.waitFor(() => {
    flushSync();
    button("从此轮分叉");
  });
  button("从此轮分叉").click();
  const dialog = target.querySelector<HTMLDialogElement>(".fork-conversation-dialog")!;
  await vi.waitFor(() => expect(dialog.open).toBe(true));
  expect(dialog.querySelector("select")?.value).toBe("turn-one");
  button("取消", dialog).click();
  expect(api.fork).not.toHaveBeenCalled();
  button("从此轮分叉").click();
  await vi.waitFor(() => expect(dialog.open).toBe(true));
  const name = dialog.querySelector("input")!;
  name.value = "另一种方案";
  name.dispatchEvent(new Event("input", { bubbles: true }));
  submit(dialog);
  await vi.waitFor(() => expect(target.querySelector("h1")?.textContent).toBe("另一种方案"));
  expect(api.fork).toHaveBeenCalledWith("甲", { title: "另一种方案", afterTurnId: "turn-one" });
  expect(item.draft).toBe("草稿甲");
  button("项目甲", target.querySelector(".conversation-relations")!).click();
  await selected("甲");
  await vi.waitFor(() =>
    expect(target.querySelector('[data-turn-id="turn-one"]')?.classList.contains("linked")).toBe(
      true,
    ),
  );
});
