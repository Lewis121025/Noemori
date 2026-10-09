import { beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentService } from "../../../../modules/notes/packages/desktop/src/features/agent/main/service";
import { ConversationStore } from "../../../../modules/notes/packages/desktop/src/features/agent/main/conversations";
import type { AgentSnapshot } from "../../../../modules/notes/packages/desktop/src/features/agent/shared/api";
import {
  parseSnapshot,
  record,
} from "../../../../modules/notes/packages/desktop/src/features/agent/shared/parse";
import { newProviderModel } from "../../../../modules/notes/packages/desktop/src/features/agent/shared/providers";

const runtime = vi.hoisted(() => ({
  starts: [] as string[],
  sessions: [] as { finish: (status?: "completed" | "cancelled") => void }[],
}));
vi.mock("electron", () => ({ safeStorage: { isEncryptionAvailable: () => true } }));
vi.mock("../../../../modules/agent/node/index.js", () => ({
  branchCheckpoint: vi.fn(),
  relocateCheckpoint: vi.fn(),
}));
vi.mock(
  "../../../../modules/notes/packages/desktop/src/features/agent/main/native-session",
  () => ({
    createNativeSession: (
      _data: string,
      _launcher: string,
      workspace: string,
      _model: unknown,
      changed: () => void,
    ) => {
      let view: AgentSnapshot = {
        id: "native",
        workspace,
        revision: 0,
        closed: false,
        run: null,
        turns: [],
        messages: [],
        terminals: [],
        approvals: [],
        browser: { status: "idle", tabs: [], receipts: [], error: null },
        ui: {
          status: "idle",
          generation: 0,
          call: null,
          error: null,
          control: null,
          connections: [],
          receipts: [],
        },
      };
      const finish = (status: "completed" | "cancelled" = "completed") => {
        if (view.run) view.run.status = status;
        view.revision += 1;
        changed();
      };
      runtime.sessions.push({ finish });
      return {
        snapshot: () => JSON.stringify(view),
        checkpoint: () => JSON.stringify({ version: 1, workspace, snapshot: view }),
        restore: (checkpoint: string) => {
          view = {
            ...parseSnapshot(JSON.stringify(record(JSON.parse(checkpoint))["snapshot"])),
            closed: false,
          };
        },
        startConfigured: (_configuration: string, _binding: string, text: string) => {
          if (view.run?.status === "running") throw new Error("已有运行");
          runtime.starts.push(text);
          view.run = {
            id: `run-${runtime.starts.length}`,
            status: "running",
            error: null,
            model_calls: 1,
          };
          view.messages.push({ role: "user", content: [{ type: "text", value: text }] });
          view.revision += 1;
          changed();
          return view.run.id;
        },
        steer: (id: string, text: string) => {
          if (view.run?.id !== id || view.run.status !== "running") throw new Error("运行已变化");
          view.messages.push({ role: "user", content: [{ type: "text", value: text }] });
          changed();
          return id;
        },
        interrupt: async (id: string) => {
          if (view.run?.id !== id) throw new Error("运行已变化");
          finish("cancelled");
        },
        cancel: () => finish("cancelled"),
        close: async () => {
          if (view.run?.status === "running") finish("cancelled");
          view.closed = true;
        },
      };
    },
  }),
);
beforeEach(() => {
  runtime.starts.length = 0;
  runtime.sessions.length = 0;
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "noemori-queued-messages-"));
  const services: AgentService[] = [];
  onTestFinished(async () => {
    vi.restoreAllMocks();
    for (const service of services) await service.shutdown();
    await rm(directory, { recursive: true, force: true });
  });
  const service = new AgentService(directory, "/launcher", () => {});
  services.push(service);
  const catalog = await service.providersSave({
    id: null,
    name: "测试连接",
    protocol: "openai-chat",
    address: { type: "base_url", url: "https://example.com/v1" },
    authentication: { type: "none" },
    models: [newProviderModel("fixture")],
  });
  const item = await service.create(null, "排队对话");
  await service.modelSelect(item.id, { providerId: catalog.providers[0]!.id, modelId: "fixture" });
  return { service, directory, id: item.id, services };
}

it("普通发送只消费匹配的草稿，另一段未发送的内容必须保留", async () => {
  const { service, id } = await setup();
  await service.saveDraft(id, "另一段独立草稿");
  await service.start(id, "本轮任务");
  expect((await service.snapshot(id)).draft).toBe("另一段独立草稿");
  runtime.sessions[0]!.finish();
  await service.saveDraft(id, "下一轮任务");
  await service.start(id, "下一轮任务");
  expect((await service.snapshot(id)).draft).toBe("");
});

it("同轮补充不启动新任务，不改变下一轮模型选择，并保留其他草稿", async () => {
  const { service, id } = await setup();
  const run = await service.start(id, "原任务");
  await service.saveDraft(id, "还未发送的另一段草稿");
  expect(await service.steer(id, run, "补充指令")).toBe(run);
  expect(runtime.starts).toEqual(["原任务"]);
  expect((await service.snapshot(id)).draft).toBe("还未发送的另一段草稿");
  await expect(service.steer(id, "old-run", "迟到指令")).rejects.toThrow("运行已变化");
});

it("追问按顺序在完成后发送，当前轮与其他草稿保持独立", async () => {
  const { service, id } = await setup();
  const run = await service.start(id, "原任务");
  await service.saveDraft(id, "第一条追问");
  await service.queueAdd(id, run, "第一条追问");
  await service.saveDraft(id, "另一个草稿");
  await service.queueAdd(id, run, "第二条追问");
  expect(runtime.starts).toEqual(["原任务"]);
  expect((await service.queueGet(id)).messages.map((message) => message.text)).toEqual([
    "第一条追问",
    "第二条追问",
  ]);
  runtime.sessions[0]!.finish();
  await vi.waitFor(() => expect(runtime.starts).toEqual(["原任务", "第一条追问"]));
  runtime.sessions[0]!.finish();
  await vi.waitFor(() => expect(runtime.starts).toEqual(["原任务", "第一条追问", "第二条追问"]));
  expect((await service.snapshot(id)).draft).toBe("另一个草稿");
  // 原生启动回执早于派发事务保存完成；核对队列结算，不能把启动通知当作落盘完成。
  await vi.waitFor(async () => expect((await service.queueGet(id)).messages).toEqual([]));
  expect(runtime.sessions).toHaveLength(1);
});

it("中断暂停追问，显式继续队列才启动新轮，重启保留内容且不自动发送", async () => {
  const { service, id, directory, services } = await setup();
  const run = await service.start(id, "原任务");
  await service.queueAdd(id, run, "待继续的追问");
  await service.cancel(id, run);
  await vi.waitFor(async () => expect((await service.queueGet(id)).paused).toBe(true));
  await service.shutdown();
  const restored = new AgentService(directory, "/launcher", () => {});
  services.push(restored);
  expect((await restored.queueGet(id)).messages[0]?.text).toBe("待继续的追问");
  expect(runtime.starts).toEqual(["原任务"]);
  await restored.queuePause(id, false);
  expect(runtime.starts).toEqual(["原任务", "待继续的追问"]);
});

it("加入或派发之前的写盘失败不启动任务，队列和草稿仍可重试", async () => {
  const { service, id } = await setup();
  const run = await service.start(id, "原任务");
  await service.saveDraft(id, "不能丢失的追问");
  const save = vi.spyOn(ConversationStore.prototype, "save");
  save.mockRejectedValueOnce(new Error("队列写入失败"));
  await expect(service.queueAdd(id, run, "不能丢失的追问")).rejects.toThrow("队列写入失败");
  expect((await service.snapshot(id)).draft).toBe("不能丢失的追问");
  expect((await service.queueGet(id)).messages).toEqual([]);
  await service.queueAdd(id, run, "不能丢失的追问");
  save.mockRestore();
  const diskSave = ConversationStore.prototype.save;
  vi.spyOn(ConversationStore.prototype, "save").mockImplementation(function (
    this: ConversationStore,
    item,
  ) {
    if (item.queue.messages[0]?.state === "sending")
      return Promise.reject(new Error("派发写入失败"));
    return diskSave.call(this, item);
  });
  runtime.sessions[0]!.finish();
  await vi.waitFor(async () => expect((await service.queueGet(id)).paused).toBe(true));
  expect(runtime.starts).toEqual(["原任务"]);
  expect((await service.queueGet(id)).messages[0]?.text).toBe("不能丢失的追问");
  vi.restoreAllMocks();
  await service.queuePause(id, false);
  expect(runtime.starts).toEqual(["原任务", "不能丢失的追问"]);
});

it("完成通知之后保存草稿不吞掉派发，接受后写盘失败的重启队列不会重复执行", async () => {
  const { service, id, directory, services } = await setup();
  const run = await service.start(id, "原任务");
  await service.queueAdd(id, run, "只能执行一次的追问");
  await service.queueAdd(id, run, "尚未派发的另一条追问");
  const diskSave = ConversationStore.prototype.save;
  vi.spyOn(ConversationStore.prototype, "save").mockImplementation(function (
    this: ConversationStore,
    item,
  ) {
    if (item.snapshot.run?.id !== run && item.snapshot.run?.status === "running")
      return Promise.reject(new Error("接受后的写盘失败"));
    return diskSave.call(this, item);
  });
  runtime.sessions[0]!.finish();
  await service.saveDraft(id, "保留独立草稿");
  await vi.waitFor(() => expect(runtime.starts).toEqual(["原任务", "只能执行一次的追问"]));
  await vi.waitFor(async () =>
    expect((await service.queueGet(id)).messages.map((message) => message.text)).toEqual([
      "尚未派发的另一条追问",
    ]),
  );
  const restored = new AgentService(directory, "/launcher", () => {});
  services.push(restored);
  const recovered = await restored.queueGet(id);
  expect(recovered).toMatchObject({
    paused: true,
    messages: [{ state: "sending" }, { state: "queued" }],
  });
  await expect(restored.queuePause(id, false)).rejects.toThrow("发送状态未确认");
  expect(await restored.queueRemove(id, recovered.messages[0]!.id)).toMatchObject({
    paused: true,
    error: null,
    messages: [{ text: "尚未派发的另一条追问", state: "queued" }],
  });
  expect(runtime.starts).toHaveLength(2);
});
