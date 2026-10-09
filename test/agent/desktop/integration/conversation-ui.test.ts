/** @vitest-environment jsdom */
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import AgentPanel from "../../../../modules/notes/packages/desktop/src/features/agent/renderer/AgentPanel.svelte";
import type {
  AgentApi,
  AgentConversation,
} from "../../../../modules/notes/packages/desktop/src/features/agent/shared/api";
import { newProviderModel } from "../../../../modules/notes/packages/desktop/src/features/agent/shared/providers";
import { createAgentApiMock } from "../../../notes/desktop/fixtures/agent-api-mock";

const originalShowPopover = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "showPopover");
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
    modelSelection: { providerId: "provider", modelId: "fixture" },
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
}
function button(label: string, scope: ParentNode = target): HTMLButtonElement {
  const result = [...scope.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === label || node.getAttribute("aria-label") === label,
  );
  if (!result) throw new Error(`缺少按钮：${label}`);
  return result;
}
function select(id: string): void {
  void panel.selectConversation(id);
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
async function openModels(): Promise<void> {
  button("选择对话模型").click();
  await vi.waitFor(() => {
    flushSync();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("搜索模型");
  });
}
async function openEfforts(): Promise<void> {
  await vi.waitFor(() => {
    flushSync();
    expect(button("选择推理强度").disabled).toBe(false);
  });
  button("选择推理强度").click();
  await vi.waitFor(() => {
    flushSync();
    expect(target.querySelector('[aria-label="对话推理强度"]')).not.toBeNull();
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
  HTMLElement.prototype.showPopover = function () {};
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  records = [conversation("甲"), conversation("乙"), conversation("丙")];
  api = {
    ...createAgentApiMock(),
    providersGet: vi.fn<AgentApi["providersGet"]>(async () => ({
      providers: [
        {
          id: "provider",
          name: "模型连接",
          protocol: "anthropic",
          address: { type: "base_url", url: "https://example.com/v1" },
          authentication: { type: "none", configured: false, name: "", region: "" },
          models: [
            newProviderModel("fixture"),
            {
              ...newProviderModel("reasoner"),
              reasoning: { supported: true, efforts: ["low", "high"] },
            },
          ],
        },
      ],
    })),
    modelSelect: vi.fn<AgentApi["modelSelect"]>(async (id, value) => {
      records.find((item) => item.id === id)!.modelSelection = value;
      return value;
    }),
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
  if (originalShowPopover)
    Object.defineProperty(HTMLElement.prototype, "showPopover", originalShowPopover);
  else Reflect.deleteProperty(HTMLElement.prototype, "showPopover");
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

it("草稿静默保存，不在输入区显示常驻状态，失败仍保留输入并提示", async () => {
  expect(target.textContent).not.toContain("草稿已保存");
  input("静默保存的输入");
  await vi.waitFor(() => expect(api.saveDraft).toHaveBeenCalledWith("甲", "静默保存的输入"));
  expect(target.textContent).not.toContain("正在保存草稿");
  vi.mocked(api.saveDraft).mockRejectedValueOnce(new Error("草稿保存失败"));
  input("保存失败也要保留");
  await vi.waitFor(() => expect(target.textContent).toContain("草稿保存失败"));
  expect(target.querySelector("textarea")?.value).toBe("保存失败也要保留");
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

it("发送前保存门禁等待期间切换会话，仍发送原会话捕获的输入", async () => {
  const gate = Promise.withResolvers<void>();
  const beforeSend = vi.fn(() => gate.promise);
  api.start = vi.fn(async () => "run");
  await unmount(panel);
  panel = mount(AgentPanel, {
    target,
    props: { api, close: () => {}, openLink: async () => {}, beforeSend },
  });
  await selected("甲");
  input("甲的明确任务");
  button("发送").click();
  await vi.waitFor(() => expect(beforeSend).toHaveBeenCalledOnce());
  await panel.selectConversation("乙");
  await selected("乙");
  gate.resolve();
  await vi.waitFor(() => expect(api.start).toHaveBeenCalledWith("甲", "甲的明确任务"));
  expect(target.querySelector("textarea")?.value).toBe("草稿乙");
});

it("旧会话发送失败的迟到回执不把错误显示在新会话", async () => {
  const accepted = Promise.withResolvers<string>();
  api.start = vi.fn(() => accepted.promise);
  input("甲的任务");
  button("发送").click();
  await vi.waitFor(() => expect(api.start).toHaveBeenCalledOnce());
  await panel.selectConversation("乙");
  accepted.reject(new Error("甲的模型连接失败"));
  await vi.waitFor(() => {
    flushSync();
    expect(target.querySelector("textarea")?.disabled).toBe(false);
  });
  expect(target.querySelector(".panel-error")).toBeNull();
  expect(target.querySelector("textarea")?.value).toBe("草稿乙");
});

it("发送失败保留原文并交还输入焦点，可以直接修改后重试", async () => {
  api.start = vi.fn(async () => { throw new Error("模型暂时不可用"); });
  input("需要保留的任务");
  button("发送").focus();
  button("发送").click();
  await vi.waitFor(() => {
    flushSync();
    expect(target.textContent).toContain("模型暂时不可用");
    expect(document.activeElement).toBe(target.querySelector("textarea"));
  });
  expect(target.querySelector("textarea")?.value).toBe("需要保留的任务");
  expect(button("发送").disabled).toBe(false);
});

it("重命名、归档、恢复、删除都有明确目标，取消删除不改变记录", async () => {
  const rename = await manage("重命名对话");
  const name = rename.querySelector("input")!;
  name.value = "明确的名称";
  name.dispatchEvent(new Event("input", { bubbles: true }));
  submit(rename);
  await vi.waitFor(() => expect(target.querySelector("h1")?.textContent).toBe("明确的名称"));
  submit(await manage("归档对话"));
  await vi.waitFor(() => expect(api.archive).toHaveBeenCalledWith("甲", true));
  await vi.waitFor(() => expect(target.textContent).toContain("此对话已归档"));
  expect(target.querySelector("textarea")).toBeNull();
  button("恢复对话").click();
  await vi.waitFor(() => expect(target.querySelector("textarea")).not.toBeNull());
  const remove = await manage("删除对话");
  button("取消", remove).click();
  expect(api.remove).not.toHaveBeenCalled();
  submit(await manage("删除对话"));
  await vi.waitFor(() => {
    flushSync();
    expect(target.querySelector("textarea")).toBeNull();
  });
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

it("启动列表与库加载刷新交错时，只用最新列表恢复会话和草稿", async () => {
  await unmount(panel);
  const first = Promise.withResolvers<Awaited<ReturnType<AgentApi["list"]>>>();
  const second = Promise.withResolvers<Awaited<ReturnType<AgentApi["list"]>>>();
  api.list = vi
    .fn()
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise);
  panel = mount(AgentPanel, { target, props: { api, close: () => {}, openLink: async () => {} } });
  await vi.waitFor(() => expect(api.list).toHaveBeenCalledOnce());
  const refresh = panel.refreshList();
  await vi.waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
  first.resolve({ items: [], issues: [] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync();
  second.resolve({ items: records.map((item) => ({ ...item, status: null })), issues: [] });
  await refresh;
  await selected("甲");
  expect(target.querySelector("textarea")?.value).toBe("草稿甲");
});

it("输入区切换模型与推理强度只针对当前对话，不覆盖草稿；运行中允许切换", async () => {
  input("继续保留的草稿");
  records[0]!.run = { id: "running", status: "running", error: null, model_calls: 1 };
  notify("甲");
  await vi.waitFor(() => {
    flushSync();
    button("停止生成");
  });
  button("选择对话模型").click();
  flushSync();
  expect(target.textContent).toContain("切换从下一轮生效");
  button("reasoner").click();
  await vi.waitFor(() => {
    flushSync();
    expect(button("选择对话模型").textContent).toContain("reasoner");
  });
  expect(target.querySelector('[aria-label="对话推理强度"]')).toBeNull();
  await openEfforts();
  const effort = target.querySelector('[aria-label="对话推理强度"]')!;
  expect(
    [...effort.querySelectorAll('[role="menuitemradio"]')].map((item) => item.textContent?.trim()),
  ).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
  button("high", effort).click();
  await vi.waitFor(() =>
    expect(api.modelSelect).toHaveBeenLastCalledWith("甲", {
      providerId: "provider",
      modelId: "reasoner",
      reasoningEffort: "high",
    }),
  );
  expect(target.querySelector("textarea")?.value).toBe("继续保留的草稿");
  select("乙");
  await selected("乙");
  expect(records[1]!.modelSelection?.modelId).toBe("fixture");
  select("甲");
  await selected("甲");
  button("选择对话模型").click();
  flushSync();
  button("fixture").click();
  await vi.waitFor(() => {
    flushSync();
    expect(target.querySelector('[aria-label="对话推理强度"]')).toBeNull();
  });
  expect(api.modelSelect).toHaveBeenLastCalledWith("甲", {
    providerId: "provider",
    modelId: "fixture",
  });
  await openEfforts();
  expect(target.textContent).not.toContain("服务商默认");
});

it("选择回执迟到时不能覆盖已经切换到的对话或草稿", async () => {
  const waiting = Promise.withResolvers<Awaited<ReturnType<AgentApi["modelSelect"]>>>();
  api.modelSelect = vi.fn(() => waiting.promise);
  button("选择对话模型").click();
  flushSync();
  button("reasoner").click();
  await vi.waitFor(() => expect(api.modelSelect).toHaveBeenCalledOnce());
  select("乙");
  await selected("乙");
  waiting.resolve({ providerId: "provider", modelId: "reasoner" });
  await waiting.promise;
  flushSync();
  expect(target.querySelector("textarea")?.value).toBe("草稿乙");
  expect(button("选择对话模型").textContent).toContain("fixture");
});

it("未选模型可写草稿但不能发送，选好模型后立即可发送", async () => {
  records[0]!.modelSelection = null;
  notify("甲");
  await vi.waitFor(() => {
    flushSync();
    expect(button("选择对话模型").textContent).toContain("选择模型");
  });
  input("先整理想法");
  expect(button("发送").disabled).toBe(true);
  button("选择对话模型").click();
  flushSync();
  button("fixture").click();
  await vi.waitFor(() => {
    flushSync();
    expect(button("发送").disabled).toBe(false);
  });
  expect(target.querySelector("textarea")?.value).toBe("先整理想法");
});

it("空目录自动获取完整模型列表；获取失败可重试并保留当前草稿", async () => {
  const providers = await api.providersGet();
  let ready = false;
  api.providersGet = vi.fn(async () =>
    ready ? providers : { providers: providers.providers.map((item) => ({ ...item, models: [] })) },
  );
  api.providersRefresh = vi
    .fn()
    .mockRejectedValueOnce(new Error("模型列表超时"))
    .mockImplementationOnce(async () => {
      ready = true;
      return providers;
    });
  input("网络故障时保留草稿");
  button("选择对话模型").click();
  await vi.waitFor(() => {
    flushSync();
    expect(target.textContent).toContain("模型列表超时");
  });
  expect(button("发送").disabled).toBe(true);
  button("刷新模型").click();
  await vi.waitFor(() => {
    flushSync();
    expect(target.textContent).not.toContain("模型列表超时");
    button("reasoner");
  });
  expect(api.providersRefresh).toHaveBeenCalledTimes(2);
  expect(target.querySelector("textarea")?.value).toBe("网络故障时保留草稿");
});

it("模型浮层聚焦搜索、说明无结果，并支持方向键选择和 Escape 返回", async () => {
  button("选择对话模型").click();
  await vi.waitFor(() => {
    flushSync();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("搜索模型");
  });
  const search = target.querySelector<HTMLInputElement>('input[aria-label="搜索模型"]')!;
  search.value = "找不到的模型";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
  expect(target.textContent).toContain("没有匹配的模型");
  search.value = "reasoner";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
  search.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  expect(document.activeElement).toBe(button("reasoner"));
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  flushSync();
  expect(target.querySelector('[aria-label="对话可用模型"]')).toBeNull();
  expect(document.activeElement).toBe(button("选择对话模型"));
  expect(api.modelSelect).not.toHaveBeenCalled();
});

it("闲置工具按需打开，正在执行的浏览器与应用状态自动显示", async () => {
  expect(target.querySelector('[aria-label="浏览器与应用控制"]')).toBeNull();
  button("对话工具").click();
  flushSync();
  button("浏览器与应用").click();
  flushSync();
  expect(target.querySelector('[aria-label="浏览器与应用控制"]')).not.toBeNull();
  select("乙");
  await selected("乙");
  expect(target.querySelector('[aria-label="浏览器与应用控制"]')).toBeNull();
  records[1]!.ui.status = "busy";
  notify("乙");
  await vi.waitFor(() => {
    flushSync();
    expect(target.querySelector('[aria-label="浏览器与应用控制"]')).not.toBeNull();
  });
});

it("再次点击当前模型只关闭浮层，保留已选推理强度", async () => {
  records[0]!.modelSelection = {
    providerId: "provider",
    modelId: "reasoner",
    reasoningEffort: "high",
  };
  notify("甲");
  await vi.waitFor(() => {
    flushSync();
    expect(button("选择推理强度").textContent).toContain("high");
  });
  button("选择对话模型").click();
  flushSync();
  button("reasoner").click();
  flushSync();
  expect(target.querySelector('[aria-label="对话可用模型"]')).toBeNull();
  expect(api.modelSelect).not.toHaveBeenCalled();
  expect(records[0]!.modelSelection.reasoningEffort).toBe("high");
});

it.each(["异步失败", "同步抛错"])(
  "推理强度保存失败恢复已保存档位，并保留错误和草稿：%s",
  async (failure) => {
    records[0]!.modelSelection = {
      providerId: "provider",
      modelId: "reasoner",
      reasoningEffort: "low",
    };
    notify("甲");
    await vi.waitFor(() => {
      flushSync();
      expect(button("选择推理强度").textContent).toContain("low");
    });
    await openEfforts();
    const receipt = Promise.withResolvers<Awaited<ReturnType<AgentApi["modelSelect"]>>>();
    api.modelSelect = vi.fn(() => {
      if (failure === "同步抛错") throw new Error("模型选择保存失败");
      return receipt.promise;
    });
    const effort = button("high", target.querySelector('[aria-label="对话推理强度"]')!);
    effort.click();
    flushSync();
    if (failure === "异步失败") {
      expect(effort.disabled).toBe(true);
      receipt.reject(new Error("模型选择保存失败"));
    }
    await vi.waitFor(() => {
      flushSync();
      expect(effort.disabled).toBe(false);
    });
    expect(
      button("low", target.querySelector('[aria-label="对话推理强度"]')!).getAttribute(
        "aria-checked",
      ),
    ).toBe("true");
    expect(target.textContent).toContain("模型选择保存失败");
    expect(target.querySelector("textarea")?.value).toBe("草稿甲");
  },
);

it.each(["继续输入", "重新打开模型列表", "移到输入框"])(
  "模型保存迟到时不打断用户%s",
  async (action) => {
    await openModels();
    const receipt = Promise.withResolvers<Awaited<ReturnType<AgentApi["modelSelect"]>>>();
    api.modelSelect = vi.fn(() => receipt.promise);
    button("reasoner").click();
    flushSync();
    if (action !== "移到输入框") {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      flushSync();
    }
    if (action === "重新打开模型列表") await openModels();
    else target.querySelector("textarea")!.focus();
    const focus = document.activeElement;
    receipt.resolve({ providerId: "provider", modelId: "reasoner" });
    await vi.waitFor(() => {
      flushSync();
      expect(button("选择对话模型").textContent).toContain("reasoner");
    });
    expect(document.activeElement).toBe(focus);
    if (action === "重新打开模型列表")
      expect(target.querySelector('[aria-label="对话可用模型"]')).not.toBeNull();
  },
);

it("模型列表的迟到成功不能清除模型选择保存失败", async () => {
  await openModels();
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  flushSync();
  const catalog = await api.providersGet();
  const listing = Promise.withResolvers<typeof catalog>();
  vi.mocked(api.providersGet).mockImplementationOnce(() => listing.promise);
  api.modelSelect = vi.fn(async () => {
    throw new Error("选择未保存，请重试");
  });
  await openModels();
  button("reasoner").click();
  await vi.waitFor(() => {
    flushSync();
    expect(target.textContent).toContain("选择未保存，请重试");
  });
  listing.resolve(catalog);
  await vi.waitFor(() => {
    flushSync();
    expect(button("刷新模型").disabled).toBe(false);
  });
  expect(target.textContent).toContain("选择未保存，请重试");
  expect(button("选择对话模型").textContent).toContain("fixture");
});

it("切换对话后迟到的空模型目录不再启动远端发现", async () => {
  await openModels();
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  flushSync();
  const catalog = await api.providersGet();
  api.providersRefresh = vi.fn(async () => catalog);
  const listing = Promise.withResolvers<typeof catalog>();
  vi.mocked(api.providersGet).mockImplementationOnce(() => listing.promise);
  await openModels();
  select("乙");
  await selected("乙");
  listing.resolve({
    providers: catalog.providers.map((provider) => ({ ...provider, models: [] })),
  });
  await listing.promise;
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync();
  expect(api.providersRefresh).not.toHaveBeenCalled();
  expect(target.querySelector("textarea")?.value).toBe("草稿乙");
});

it("模型目录刷新保留手动档位，独立菜单可以重新选择明确强度", async () => {
  records[0]!.modelSelection = {
    providerId: "provider",
    modelId: "reasoner",
    reasoningEffort: "high",
  };
  notify("甲");
  await vi.waitFor(() => {
    flushSync();
    expect(button("选择推理强度").textContent).toContain("high");
  });
  const catalog = await api.providersGet();
  catalog.providers[0]!.models[1]!.reasoning = { supported: true, efforts: ["low"] };
  api.providersGet = vi.fn(async () => catalog);
  await openModels();
  await vi.waitFor(() => {
    flushSync();
    expect(button("刷新模型").disabled).toBe(false);
  });
  button("reasoner").click();
  expect(api.modelSelect).not.toHaveBeenCalled();
  await openEfforts();
  button("medium", target.querySelector('[aria-label="对话推理强度"]')!).click();
  await vi.waitFor(() => {
    flushSync();
    expect(api.modelSelect).toHaveBeenCalledWith("甲", {
      providerId: "provider",
      modelId: "reasoner",
      reasoningEffort: "medium",
    });
    expect(button("发送").disabled).toBe(false);
  });
});

it("消息的无障碍身份区分系统、用户、助手和工具", async () => {
  records[0]!.messages = [
    { role: "system", content: [{ type: "text", value: "会话约束" }] },
    { role: "user", content: [{ type: "text", value: "用户问题" }] },
    { role: "assistant", content: [{ type: "text", value: "助手回复" }] },
    { role: "tool", content: [{ type: "text", value: "工具结果" }] },
  ];
  notify("甲");
  await vi.waitFor(() => {
    flushSync();
    expect(target.querySelectorAll(".messages article")).toHaveLength(4);
  });
  expect(
    [...target.querySelectorAll(".messages article")].map((item) =>
      item.getAttribute("aria-label"),
    ),
  ).toEqual(["系统", "你", "助手", "工具"]);
});
