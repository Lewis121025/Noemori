import { expect, it, vi } from "vitest";
import { mkdtemp, rm, realpath, writeFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentService } from "../../../../modules/notes/packages/desktop/src/features/agent/main/service";
import type { AgentSnapshot } from "../../../../modules/notes/packages/desktop/src/features/agent/shared/api";
import {
  parseSnapshot,
  record,
} from "../../../../modules/notes/packages/desktop/src/features/agent/shared/parse";
import { newProviderModel } from "../../../../modules/notes/packages/desktop/src/features/agent/shared/providers";

const runtime = vi.hoisted(() => ({
  created: 0,
  restored: 0,
  starts: 0,
  contexts: [] as string[],
  configurations: [] as string[],
  closed: 0,
  notify: () => {},
}));
vi.mock("../../../../modules/agent/node/index.js", () => ({
  branchCheckpoint: async (checkpoint: string) => {
    const saved = record(JSON.parse(checkpoint));
    return JSON.stringify({ checkpoint, snapshot: saved["snapshot"] });
  },
}));
vi.mock("electron", () => ({ safeStorage: { isEncryptionAvailable: () => true } }));
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
      runtime.created += 1;
      runtime.notify = changed;
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
      };
      return {
        snapshot: () => JSON.stringify(view),
        checkpoint: () => JSON.stringify({ version: 1, workspace, snapshot: view }),
        restore: (value: string) => {
          runtime.restored += 1;
          view = {
            ...parseSnapshot(JSON.stringify(record(JSON.parse(value))["snapshot"])),
            closed: false,
          };
        },
        startConfigured: (configuration: string, _binding: string, text: string, context?: string) => {
          if (context) runtime.contexts.push(context);
          if (view.run?.status === "running") throw new Error("已有运行");
          runtime.configurations.push(configuration);
          runtime.starts += 1;
          view.messages.push({ role: "user", content: [{ type: "text", value: text }] });
          view.run = {
            id: `run-${runtime.starts}`,
            status: "running",
            error: null,
            model_calls: 1,
          };
          view.revision += 1;
          changed();
          return `run-${runtime.starts}`;
        },
        interrupt: async (id: string) => {
          if (view.run?.id !== id) throw new Error("运行已变化");
          if (view.run.status === "running") view.run.status = "cancelled";
          changed();
        },
        cancel: () => {
          if (view.run) view.run.status = "cancelled";
          changed();
        },
        close: async () => {
          runtime.closed += 1;
          view.closed = true;
          if (view.run?.status === "running") view.run.status = "cancelled";
          changed();
        },
      };
    },
  }),
);

async function configured(directory: string): Promise<AgentService> {
  const service = new AgentService(directory, "/launcher", () => {});
  await service.providersSave({
    protocol: "openai-chat",
    id: null,
    name: "测试供应商",
    address: { type: "endpoint", url: "https://example.com/chat" },
    authentication: { type: "none" },
    models: [{ id: "fixture", tools: true,
    streaming: true,
    vision: false,
    audio: false,
    video: false }],
  });
  return service;
}

it("所有历史会话下一轮使用最新模型，当前轮不变且不重建后台资源，重启后仍生效", async (test) => {
  const directory = await mkdtemp(join(tmpdir(), "noemori-global-model-"));
  test.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const service = await configured(directory);
  const first = await service.create("/workspace", "原有会话一");
  const second = await service.create("/workspace", "原有会话二");
  const running = await service.start(first.id, "本轮使用旧配置");
  const created = runtime.created;
  const catalog = await service.providersSave({ id: null, name: "新供应商", protocol: "openai-chat", address: { type: "base_url", url: "https://new.example/v1" }, authentication: { type: "none" }, models: [newProviderModel("replacement")] });
  const provider = catalog.providers.at(-1)!;
  await service.modelSelect({ providerId: provider.id, modelId: "replacement" });
  expect(runtime.created).toBe(created);
  expect((await service.snapshot(first.id)).model).toBe("fixture");
  expect((await service.snapshot(first.id)).run?.id).toBe(running);
  expect((await service.snapshot(second.id)).model).toBe("replacement");
  await service.cancel(first.id, running);
  await service.start(first.id, "本轮使用新配置");
  expect(JSON.parse(runtime.configurations.at(-1)!)).toMatchObject({ model: "replacement", endpoint: "https://new.example/v1/chat/completions" });
  await service.start(second.id, "另一条旧会话也切换");
  expect(JSON.parse(runtime.configurations.at(-1)!)).toMatchObject({ model: "replacement" });
  expect(runtime.created).toBe(created);
  await service.shutdown();
  const restarted = new AgentService(directory, "/launcher", () => {});
  await restarted.start(first.id, "重启后继续");
  expect(JSON.parse(runtime.configurations.at(-1)!)).toMatchObject({ model: "replacement" });
  await restarted.shutdown();
});

it("重启先读取历史和草稿，明确发送后才恢复原生会话，归档可以恢复继续", async (test) => {
  const directory = await mkdtemp(join(tmpdir(), "noemori-conversation-service-"));
  test.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const first = await configured(directory);
  const item = await first.create("/workspace", "项目计划");
  await first.start(item.id, "记住项目目标");
  await first.saveDraft(item.id, "下一步讨论");
  await first.shutdown();
  const before = { ...runtime };
  const next = new AgentService(directory, "/launcher", () => {});
  expect((await next.list()).items[0]?.title).toBe("项目计划");
  expect((await next.snapshot(item.id)).draft).toBe("下一步讨论");
  expect(runtime.created).toBe(before.created);
  await next.start(item.id, "继续");
  expect(runtime.restored).toBe(before.restored + 1);
  expect((await next.snapshot(item.id)).messages).toHaveLength(2);
  await next.archive(item.id, true);
  expect((await next.snapshot(item.id)).archived).toBe(true);
  await expect(next.start(item.id, "不可直接继续")).rejects.toThrow("归档");
  await next.archive(item.id, false);
  await next.start(item.id, "恢复后的新任务");
  await next.shutdown();
});

it("同一会话的改名、归档和删除串行，关闭服务不会把已删除记录写回来", async (test) => {
  const directory = await mkdtemp(join(tmpdir(), "noemori-conversation-service-"));
  test.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const service = await configured(directory);
  const a = await service.create("/one", "甲");
  const b = await service.create("/two", "乙");
  await Promise.all([
    service.rename(a.id, "新名字"),
    service.archive(a.id, true),
    service.remove(a.id),
  ]);
  expect((await service.list()).items.map((item) => item.id)).toEqual([b.id]);
  await service.shutdown();
  const restored = new AgentService(directory, "/launcher", () => {});
  expect((await restored.list()).items.map((item) => item.id)).toEqual([b.id]);
  await restored.shutdown();
});

it("发送前存储失败不执行任务，原生接受后的存储失败不会伪报发送失败", async (test) => {
  const { ConversationStore } =
    await import("../../../../modules/notes/packages/desktop/src/features/agent/main/conversations");
  const directory = await mkdtemp(join(tmpdir(), "noemori-conversation-storage-"));
  test.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const service = await configured(directory);
  const item = await service.create("/workspace", "存储故障");
  const before = runtime.starts;
  const original = ConversationStore.prototype.save;
  const save = vi.spyOn(ConversationStore.prototype, "save");
  const logging = vi.spyOn(console, "error").mockImplementation(() => {});
  test.onTestFinished(() => {
    save.mockRestore();
    logging.mockRestore();
  });
  save.mockRejectedValueOnce(new Error("存储不可写"));
  await expect(service.start(item.id, "不能发送")).rejects.toThrow("存储不可写");
  expect(runtime.starts).toBe(before);
  save.mockImplementationOnce(original).mockRejectedValueOnce(new Error("执行已开始后写入失败"));
  await expect(service.start(item.id, "只执行一次")).resolves.toMatch(/^run-/u);
  expect(runtime.starts).toBe(before + 1);
  expect((await service.snapshot(item.id)).storageError).toContain("执行已开始后写入失败");
  expect((await service.snapshot(item.id)).draft).toBe("");
  await service.flush();
  expect((await service.snapshot(item.id)).storageError).toBeNull();
  await service.shutdown();
});

it("原生资源关闭后的迟到通知不能把已经删除的记录重新写回磁盘", async (test) => {
  const { ConversationStore } =
    await import("../../../../modules/notes/packages/desktop/src/features/agent/main/conversations");
  const directory = await mkdtemp(join(tmpdir(), "noemori-conversation-late-notify-"));
  test.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const service = await configured(directory);
  const item = await service.create("/workspace", "即将删除");
  const deleted = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<void>();
  const original = ConversationStore.prototype.remove;
  const remove = vi.spyOn(ConversationStore.prototype, "remove").mockImplementation(async function (
    this: InstanceType<typeof ConversationStore>,
    id,
  ) {
    await original.call(this, id);
    deleted.resolve();
    await completed.promise;
  });
  test.onTestFinished(() => remove.mockRestore());
  const deleting = service.remove(item.id);
  await deleted.promise;
  runtime.notify();
  await new Promise((resolve) => setTimeout(resolve, 250));
  completed.resolve();
  await deleting;
  await service.shutdown();
  const restored = new AgentService(directory, "/launcher", () => {});
  expect((await restored.list()).items).toEqual([]);
  await restored.shutdown();
});

it("中断结算后可继续，重复或过期的继续请求不重复执行，未发送草稿保持不变", async (test) => {
  const directory = await mkdtemp(join(tmpdir(), "noemori-conversation-resume-"));
  test.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const service = await configured(directory);
  const item = await service.create("/workspace", "继续任务");
  const run = await service.start(item.id, "整理计划");
  await expect(service.resume(item.id, run)).rejects.toThrow("尚未停止");
  await service.cancel(item.id, run);
  expect((await service.snapshot(item.id)).run?.status).toBe("cancelled");
  await service.saveDraft(item.id, "还没决定发送的想法");
  const before = runtime.starts;
  const resumed = await Promise.allSettled([
    service.resume(item.id, run),
    service.resume(item.id, run),
  ]);
  expect(resumed.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
  expect(runtime.starts).toBe(before + 1);
  await expect(service.cancel(item.id, run)).rejects.toThrow("运行已变化");
  const snapshot = await service.snapshot(item.id);
  expect(snapshot.draft).toBe("还没决定发送的想法");
  expect(snapshot.run?.status).toBe("running");
  await service.shutdown();
});

it("分叉独立保存来源和草稿，删除原会话不会删除分支，重启仍可继续", async (test) => {
  const directory = await mkdtemp(join(tmpdir(), "noemori-conversation-fork-"));
  test.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const service = await configured(directory);
  const original = await service.create("/workspace", "来源会话");
  const run = await service.start(original.id, "作为分叉起点的任务");
  await service.cancel(original.id, run);
  await service.saveDraft(original.id, "原会话自己的草稿");
  const before = runtime.starts;
  const fork = await service.fork(original.id, { title: "独立方向", afterTurnId: null });
  expect(fork.id).not.toBe(original.id);
  expect(fork.origin).toEqual({ conversationId: original.id, title: "来源会话", turnId: null });
  expect(fork.draft).toBe("");
  expect(runtime.starts).toBe(before);
  expect((await service.snapshot(original.id)).draft).toBe("原会话自己的草稿");
  await service.remove(original.id);
  await service.shutdown();
  const restored = new AgentService(directory, "/launcher", () => {});
  expect((await restored.list()).items).toHaveLength(1);
  await restored.start(fork.id, "沿着分支继续");
  expect((await restored.snapshot(fork.id)).messages).toHaveLength(2);
  await restored.shutdown();
});

it("窗口重载与退出清理不改变会话的活动时间及下次打开的排序", async (test) => {
  const directory = await mkdtemp(join(tmpdir(), "noemori-conversation-order-"));
  test.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
  test.onTestFinished(() => clock.mockRestore());
  const service = await configured(directory);
  const first = await service.create("/workspace", "先前任务");
  await service.start(first.id, "第一项任务");
  clock.mockReturnValue(2000);
  const second = await service.create("/workspace", "最近任务");
  await service.start(second.id, "第二项任务");
  const before = (await service.list()).items.map(({ id, updatedAt }) => ({ id, updatedAt }));
  clock.mockReturnValue(3000);
  service.detach();
  await service.shutdown();
  const restored = new AgentService(directory, "/launcher", () => {});
  expect((await restored.list()).items.map(({ id, updatedAt }) => ({ id, updatedAt }))).toEqual(
    before,
  );
  await restored.shutdown();
});

it("文章会话归属随改名迁移，每轮更新段落，删除文章不删除对话", async (test) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "noemori-article-service-")));
  test.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "原文.md"), "# 标题\n\n原段落\n");
  const service = await configured(directory);
  const item = await service.createArticle({ root: directory, path: "原文.md", title: "文章问题" });
  expect(item.article?.status).toBe("marker-missing");
  const marker = `[讨论](noemori://conversation/${item.id})`;
  await writeFile(join(directory, "原文.md"), `# 标题\n\n修改后的段落${marker}\n`);
  const first = await service.start(item.id, "提问");
  expect(runtime.contexts.at(-1)).toContain("修改后的段落");
  await service.cancel(item.id, first);
  await rename(join(directory, "原文.md"), join(directory, "新名称.md"));
  await service.remapArticles(directory, [{ from: "原文.md", to: "新名称.md" }]);
  expect((await service.snapshot(item.id)).article?.path).toBe("新名称.md");
  await writeFile(join(directory, "新名称.md"), `新增段落\n\n新一版正文${marker}`);
  const second = await service.start(item.id, "再次提问");
  expect(runtime.contexts.at(-1)).toContain("新一版正文");
  expect(runtime.contexts.at(-1)).not.toContain("修改后的段落");
  await service.cancel(item.id, second);
  await rm(join(directory, "新名称.md"));
  await service.remapArticles(directory, [{ from: "新名称.md", to: null }]);
  expect((await service.snapshot(item.id)).article?.status).toBe("article-missing");
  expect((await service.list()).items).toHaveLength(1);
  await service.shutdown();
  const restored = new AgentService(directory, "/launcher", () => {});
  await restored.attachVault(directory);
  expect((await restored.snapshot(item.id)).article?.status).toBe("article-missing");
  await restored.shutdown();
});
