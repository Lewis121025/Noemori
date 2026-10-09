import { expect, it, onTestFinished, vi } from "vitest";
import { mkdtemp, rm, realpath, writeFile, rename, readFile, mkdir, copyFile, cp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentService } from "../../../../modules/notes/packages/desktop/src/features/agent/main/service";
import type { AgentSnapshot } from "../../../../modules/notes/packages/desktop/src/features/agent/shared/api";
import {
  parseSnapshot,
  record,
} from "../../../../modules/notes/packages/desktop/src/features/agent/shared/parse";
import { newProviderModel } from "../../../../modules/notes/packages/desktop/src/features/agent/shared/providers";
import { readConversationInput } from "../../../../modules/notes/packages/desktop/src/features/agent/shared/input";

const runtime = vi.hoisted(() => ({
  created: 0,
  restored: 0,
  starts: 0,
  terminalActions: 0,
  contexts: [] as string[],
  configurations: [] as string[],
  closed: 0,
  rejectNextStart: false,
  bridgeUpdated: true,
  notify: () => {},
}));
vi.mock("../../../../modules/agent/node/index.js", () => ({
  branchCheckpoint: async (checkpoint: string) => {
    const saved = record(JSON.parse(checkpoint));
    return JSON.stringify({ checkpoint, snapshot: saved["snapshot"] });
  },
  relocateCheckpoint: async (checkpoint: string, workspace: string) => {
    const saved = record(JSON.parse(checkpoint));
    return JSON.stringify({
      ...saved,
      workspace,
      snapshot: { ...record(saved["snapshot"]), workspace },
    });
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
      const startConfigured = (
          configuration: string,
          _binding: string,
          text: string,
          context?: string,
        ) => {
          if (context) runtime.contexts.push(context);
          if (view.run?.status === "running") throw new Error("已有运行");
          if (runtime.rejectNextStart) { runtime.rejectNextStart = false; throw new Error("原生请求预算不足"); }
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
        startConfigured,
        startConfiguredWithAttachments: runtime.bridgeUpdated ? (configuration: string, binding: string, text: string, context?: string, images?: string) => {
          const run = startConfigured(configuration, binding, text, context);
          if (images) {
            const raw: unknown = JSON.parse(images);
            if (!Array.isArray(raw)) throw new Error("图片载荷无效");
            for (const image of raw) view.messages.at(-1)!.content.push({ type: "image", value: image });
          }
          return run;
        } : undefined,
        interrupt: async (id: string) => {
          if (view.run?.id !== id) throw new Error("运行已变化");
          if (view.run.status === "running") view.run.status = "cancelled";
          changed();
        },
        cancel: () => {
          if (view.run) view.run.status = "cancelled";
          changed();
        },
        terminalAction: async () => {
          runtime.terminalActions += 1;
          return JSON.stringify({ outcome: "fixture" });
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
    models: [
      { id: "fixture", tools: true, streaming: true, vision: false, audio: false, video: false },
    ],
  });
  return service;
}

async function selectFixture(service: AgentService, id: string): Promise<void> {
  const provider = (await service.providersGet()).providers[0]!;
  await service.modelSelect(id, { providerId: provider.id, modelId: "fixture" });
}
async function createSelected(service: AgentService, workspace: string, title: string) {
  const item = await service.create(workspace, title);
  await selectFixture(service, item.id);
  return service.snapshot(item.id);
}

it("附件与草稿按对话保存，重启、排队和分叉保留副本，跨会话身份被拒绝", async () => {
  const directory = await mkdtemp(join(tmpdir(), "noemori-attachment-service-"));
  const services: AgentService[] = [];
  onTestFinished(async () => {
    await Promise.all(services.map((service) => service.shutdown()));
    await rm(directory, { recursive: true, force: true });
  });
  const service = await configured(directory);
  services.push(service);
  const first = await service.create(null, "文件资料"), second = await service.create(null, "另一个对话");
  await selectFixture(service, first.id);
  const path = join(directory, "资料.txt");
  await writeFile(path, "真实附件原文");
  const files = await service.addAttachments(first.id, [path]);
  await service.saveDraft(first.id, "读取资料", [], files.map((file) => file.id));
  await writeFile(path, "源文件随后修改");
  await expect(service.attachmentPreview(second.id, files[0]!.id)).rejects.toThrow("不属于");
  await service.shutdown();
  const restored = new AgentService(directory, "/launcher", () => {});
  services.push(restored);
  expect((await restored.snapshot(first.id)).draftAttachments).toEqual(files);
  expect(await restored.attachmentPreview(first.id, files[0]!.id)).toMatchObject({ text: "真实附件原文" });
  const run = await restored.start(first.id, "读取资料", [], [files[0]!.id]);
  const sent = await restored.snapshot(first.id);
  expect(sent.draftAttachments ?? []).toEqual([]);
  const input = readConversationInput(sent.messages[0]!.content.find((part) => part.type === "text")!.value.toString());
  expect(input.attachments).toEqual(files);
  await restored.saveDraft(first.id, "后续读取", [], [files[0]!.id]);
  const queue = await restored.queueAdd(first.id, run, "后续读取", [], [files[0]!.id]);
  expect(readConversationInput(queue.messages[0]!.text).attachments).toEqual(files);
  await restored.cancel(first.id, run);
  const fork = await restored.fork(first.id, { title: "附件分叉", afterTurnId: null });
  await restored.remove(first.id);
  expect(await restored.attachmentPreview(fork.id, files[0]!.id)).toMatchObject({ text: "真实附件原文" });
});

it("文件导入与输入草稿并发时保留新附件，只有显式空列表才移除附件", async (test) => {
  const directory = await mkdtemp(join(tmpdir(), "noemori-attachment-draft-race-"));
  const service = await configured(directory);
  test.onTestFinished(async () => { await service.shutdown(); await rm(directory, { recursive: true, force: true }); });
  const conversation = await service.create(null, "上传中输入");
  const importing = service.addAttachments(conversation.id, [{ name: "资料.txt", bytes: new TextEncoder().encode("资料") }]);
  const typing = service.saveDraft(conversation.id, "上传时继续输入", []);
  const [files] = await Promise.all([importing, typing]);
  const saved = await service.snapshot(conversation.id);
  expect(saved.draft).toBe("上传时继续输入");
  expect(saved.draftAttachments).toEqual(files);
  await service.saveDraft(conversation.id, "保留文字", [], []);
  expect((await service.snapshot(conversation.id)).draftAttachments ?? []).toEqual([]);
  expect(await readdir(join(directory, "agent-attachments/owned", conversation.id))).toEqual([]);
});

it("分叉只拥有历史实际引用的附件，移除队列和草稿会回收未发送副本", async (test) => {
  const directory = await mkdtemp(join(tmpdir(), "noemori-attachment-references-"));
  const service = await configured(directory);
  test.onTestFinished(async () => { await service.shutdown(); await rm(directory, { recursive: true, force: true }); });
  const conversation = await service.create(null, "引用归属");
  await selectFixture(service, conversation.id);
  const [sent] = await service.addAttachments(conversation.id, [{ name: "已发送.txt", bytes: new TextEncoder().encode("已发送") }]);
  const run = await service.start(conversation.id, "读取", [], [sent!.id]);
  const [queued] = await service.addAttachments(conversation.id, [{ name: "待发送.txt", bytes: new TextEncoder().encode("待发送") }]);
  const queue = await service.queueAdd(conversation.id, run, "下一轮", [], [queued!.id]);
  const [draft] = await service.addAttachments(conversation.id, [{ name: "草稿.txt", bytes: new TextEncoder().encode("草稿") }]);
  await service.cancel(conversation.id, run);
  const fork = await service.fork(conversation.id, { title: "独立分支", afterTurnId: null });
  await expect(service.attachmentPreview(fork.id, queued!.id)).rejects.toThrow("不属于");
  await expect(service.attachmentPreview(fork.id, draft!.id)).rejects.toThrow("不属于");
  expect(await readdir(join(directory, "agent-attachments/owned", fork.id))).toHaveLength(1);
  await service.saveDraft(conversation.id, "", [], []);
  expect(await service.attachmentPreview(conversation.id, queued!.id)).toMatchObject({ text: "待发送" });
  await service.queueRemove(conversation.id, queue.messages[0]!.id);
  await expect(service.attachmentPreview(conversation.id, queued!.id)).rejects.toThrow("不属于");
  expect(await service.attachmentPreview(conversation.id, sent!.id)).toMatchObject({ text: "已发送" });
  expect(await readdir(join(directory, "agent-attachments/owned", conversation.id))).toHaveLength(1);
});

it("原生接受前拒绝会撤销本次工具发布，保留草稿和冻结副本供用户重试", async (test) => {
  const directory = await mkdtemp(join(tmpdir(), "noemori-attachment-rejection-"));
  const service = await configured(directory);
  test.onTestFinished(async () => { await service.shutdown(); await rm(directory, { recursive: true, force: true }); });
  const item = await service.create(null, "发送拒绝");
  await selectFixture(service, item.id);
  const files = await service.addAttachments(item.id, [{ name: "资料.txt", bytes: new TextEncoder().encode("不能丢失的副本") }]);
  runtime.rejectNextStart = true;
  await expect(service.start(item.id, "", [], [files[0]!.id])).rejects.toThrow("预算不足");
  expect((await service.snapshot(item.id)).draftAttachments).toEqual(files);
  expect(await readdir(join(directory, "agent-attachments/published", item.id))).toEqual([]);
  expect(await service.attachmentPreview(item.id, files[0]!.id)).toMatchObject({ text: "不能丢失的副本" });
  await service.start(item.id, "", [], [files[0]!.id]);
  expect(await readdir(join(directory, "agent-attachments/published", item.id))).toHaveLength(1);
});

it("旧原生桥接明确拒绝附件，不伪报成功，也不消费草稿或发布文件", async (test) => {
  const directory = await mkdtemp(join(tmpdir(), "noemori-attachment-old-bridge-"));
  const service = await configured(directory);
  test.onTestFinished(async () => { runtime.bridgeUpdated = true; await service.shutdown(); await rm(directory, { recursive: true, force: true }); });
  const item = await service.create(null, "旧桥接");
  await selectFixture(service, item.id);
  const files = await service.addAttachments(item.id, [{ name: "资料.txt", bytes: new TextEncoder().encode("原文") }]);
  runtime.bridgeUpdated = false;
  const starts = runtime.starts;
  await expect(service.start(item.id, "", [], [files[0]!.id])).rejects.toThrow("原生附件模块尚未更新");
  expect(runtime.starts).toBe(starts);
  expect((await service.snapshot(item.id)).draftAttachments).toEqual(files);
  expect(await readdir(join(directory, "agent-attachments/published", item.id))).toEqual([]);
});

it("导入后保存失败整批回滚副本，原草稿与附件目录保持完整", async (test) => {
  const { ConversationStore } = await import("../../../../modules/notes/packages/desktop/src/features/agent/main/conversations");
  const directory = await mkdtemp(join(tmpdir(), "noemori-attachment-save-failure-"));
  const service = await configured(directory);
  test.onTestFinished(async () => { await service.shutdown(); await rm(directory, { recursive: true, force: true }); });
  const item = await service.create(null, "保存失败");
  await service.saveDraft(item.id, "原草稿");
  const save = vi.spyOn(ConversationStore.prototype, "save").mockRejectedValueOnce(new Error("磁盘写入失败"));
  test.onTestFinished(() => save.mockRestore());
  await expect(service.addAttachments(item.id, [{ name: "资料.txt", bytes: new TextEncoder().encode("原文") }])).rejects.toThrow("磁盘写入失败");
  expect((await service.snapshot(item.id)).draft).toBe("原草稿");
  expect((await service.snapshot(item.id)).draftAttachments ?? []).toEqual([]);
  expect(await readdir(join(directory, "agent-attachments/owned", item.id))).toEqual([]);
});

it("目录副本保留文章对话身份与分支，新仓库中的路径重绑且原历史不改写", async (test) => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "noemori-import-history-")));
  const services: AgentService[] = [];
  test.onTestFinished(async () => {
    await Promise.all(services.map(service => service.shutdown()));
    await rm(base, { recursive: true, force: true });
  });
  const source = join(base, "资料"), root = join(base, "Noemori"), data = join(base, "state");
  await mkdir(join(source, "章节"), { recursive: true });
  await mkdir(join(root, "资料/章节"), { recursive: true });
  await writeFile(join(source, "章节/笔记.md"), "# 笔记\n");
  const original = await configured(data);
  services.push(original);
  const article = await original.createArticle({ root: source, path: "章节/笔记.md", title: "讨论笔记" });
  await original.saveDraft(article.id, "继续讨论", [{ id: "quoted", text: "笔记", source: { root: source, path: "章节/笔记.md", offset: 0, sourceText: "笔记" } }]);
  const fork = await original.fork(article.id, { title: "进一步推导", afterTurnId: null });
  await original.shutdown();
  const history = join(source, ".noemori/agent/conversations", `${article.id}.json`);
  const before = await readFile(history);
  await copyFile(join(source, "章节/笔记.md"), join(root, "资料/章节/笔记.md"));
  await cp(join(source, ".noemori"), join(root, "资料/.noemori"), { recursive: true });
  await writeFile(join(root, "资料/.noemori-library-source.json"), JSON.stringify({ version: 1, source }));
  const imported = new AgentService(data, "/launcher", () => {});
  services.push(imported);
  await imported.importArticleLibrary(source, root, "资料");
  const current = await imported.snapshot(article.id);
  expect(current.workspace).toBe(root);
  expect(current.article?.path).toBe("资料/章节/笔记.md");
  expect(current.draftReferences?.[0]?.source).toMatchObject({ root, path: "资料/章节/笔记.md" });
  expect((await imported.snapshot(fork.id)).origin?.conversationId).toBe(article.id);
  expect(await readFile(history)).toEqual(before);
  await imported.importArticleLibrary(source, root, "资料");
  await imported.shutdown();
  await rm(source, { recursive: true, force: true });
  const restored = new AgentService(data, "/launcher", () => {});
  services.push(restored);
  await restored.attachVault(root);
  expect((await restored.snapshot(article.id)).article?.path).toBe("资料/章节/笔记.md");
  expect((await restored.snapshot(fork.id)).workspace).toBe(root);
});

it("引用草稿跨重启保留，发送仅消费匹配的文字与引用，模型收到来源和选中原文", async (test) => {
  const directory = await mkdtemp(join(tmpdir(), "noemori-reference-service-"));
  const services: AgentService[] = [];
  test.onTestFinished(async () => {
    await Promise.all(services.map((service) => service.shutdown()));
    await rm(directory, { recursive: true, force: true });
  });
  const service = await configured(directory);
  services.push(service);
  const item = await createSelected(service, directory, "引用任务");
  const quote = { id: "quoted", text: "原文😀", source: { root: "/another-vault", path: "资料/原文.md", offset: 0, sourceText: "原文😀" } };
  await service.saveDraft(item.id, "解释引用", [quote]);
  await service.shutdown();
  const restored = new AgentService(directory, "/launcher", () => {});
  services.push(restored);
  expect((await restored.snapshot(item.id)).draftReferences).toEqual([quote]);
  await restored.start(item.id, "解释引用", [quote]);
  const sent = await restored.snapshot(item.id);
  expect(sent.workspace).toBe(item.workspace);
  expect(sent.draft).toBe("");
  expect(sent.draftReferences).toBeUndefined();
  expect(JSON.stringify(sent.messages)).toContain("资料/原文.md");
  expect(JSON.stringify(sent.messages)).toContain("原文😀");
});

/** 挂起步骤也属于夹具；测试失败时先放行并结算服务，避免清理后的目录被迟到写入重建。 */
async function closingFixture() {
  const directory = await mkdtemp(join(tmpdir(), "noemori-close-boundary-"));
  const release = Promise.withResolvers<void>();
  const services: AgentService[] = [];
  onTestFinished(async () => {
    release.resolve();
    const results = await Promise.allSettled(services.map((service) => service.shutdown()));
    await rm(directory, { recursive: true, force: true });
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length) throw new AggregateError(failures, "关闭边界测试未能清理服务");
  });
  const service = await configured(directory);
  services.push(service);
  const item = await createSelected(service, directory, "关闭边界");
  return { directory, service, item, release, services };
}

it.each(["模型请求", "终端动作"])("关闭发生在%s的资源激活期间时，不创建迟到资源", async (kind) => {
  const { AgentProviderStore } =
    await import("../../../../modules/notes/packages/desktop/src/features/agent/main/providers");
  const { service, item, release } = await closingFixture();
  const entered = Promise.withResolvers<void>();
  const original = AgentProviderStore.prototype.selected;
  const selected = vi
    .spyOn(AgentProviderStore.prototype, "selected")
    .mockImplementationOnce(async function (this: InstanceType<typeof AgentProviderStore>, value) {
      entered.resolve();
      await release.promise;
      return original.call(this, value);
    });
  onTestFinished(() => selected.mockRestore());
  const before = runtime.created;
  const actionsBefore = runtime.terminalActions;
  const pending =
    kind === "模型请求"
      ? service.start(item.id, "准备发送")
      : service.terminalAction(item.id, { action: "exec", cmd: "printf fixture" });
  const settled = Promise.allSettled([pending]);
  await entered.promise;
  const closing = service.shutdown();
  release.resolve();
  const [result] = await settled;
  await closing;
  expect(result).toMatchObject({ status: "rejected", reason: new Error("Agent 服务正在关闭") });
  expect(runtime.created).toBe(before);
  expect(runtime.terminalActions).toBe(actionsBefore);
});

it("关闭发生在发送前保存期间时，不再派发模型且保留未发送草稿", async () => {
  const { ConversationStore } =
    await import("../../../../modules/notes/packages/desktop/src/features/agent/main/conversations");
  const { directory, service, item, release, services } = await closingFixture();
  await service.saveDraft(item.id, "必须保留的任务");
  const entered = Promise.withResolvers<void>();
  const original = ConversationStore.prototype.save;
  const save = vi.spyOn(ConversationStore.prototype, "save").mockImplementationOnce(async function (
    this: InstanceType<typeof ConversationStore>,
    value,
  ) {
    entered.resolve();
    await release.promise;
    await original.call(this, value);
  });
  onTestFinished(() => save.mockRestore());
  const before = runtime.starts;
  const sending = service.start(item.id, "必须保留的任务");
  const settled = Promise.allSettled([sending]);
  await entered.promise;
  const closing = service.shutdown();
  release.resolve();
  const [result] = await settled;
  await closing;
  expect(result).toMatchObject({ status: "rejected", reason: new Error("Agent 服务正在关闭") });
  expect(runtime.starts).toBe(before);
  const restored = new AgentService(directory, "/launcher", () => {});
  services.push(restored);
  expect((await restored.snapshot(item.id)).draft).toBe("必须保留的任务");
  await restored.shutdown();
});

it("无文件或目录关联的对话可发送、分叉和重启恢复，内部工作目录不作为关联展示", async (test) => {
  const directory = await mkdtemp(join(tmpdir(), "noemori-independent-chat-"));
  test.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const service = await configured(directory);
  const item = await service.create(null, "随时讨论");
  expect(item.workspace).toBeNull();
  expect(item.article).toBeNull();
  expect((await service.list()).items[0]?.workspace).toBeNull();
  await service.saveDraft(item.id, "先整理想法");
  await selectFixture(service, item.id);
  const run = await service.start(item.id, "独立任务");
  await service.cancel(item.id, run);
  const fork = await service.fork(item.id, { title: "另一个方向", afterTurnId: null });
  expect(fork.workspace).toBeNull();
  await service.shutdown();
  const restored = new AgentService(directory, "/launcher", () => {});
  expect((await restored.snapshot(item.id)).workspace).toBeNull();
  expect((await restored.snapshot(fork.id)).workspace).toBeNull();
  await restored.start(fork.id, "继续分支");
  expect((await restored.snapshot(fork.id)).messages).toHaveLength(2);
  await restored.shutdown();
});

it("未配置模型也能创建、保存草稿和分叉，首次发送才创建原生资源", async (test) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "noemori-lazy-model-")));
  test.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const service = new AgentService(directory, "/launcher", () => {});
  const created = runtime.created;
  const item = await service.create(directory, "稍后选模型");
  expect(item.modelSelection).toBeNull();
  await service.saveDraft(item.id, "先写草稿");
  const fork = await service.fork(item.id, { title: "草稿方向", afterTurnId: null });
  expect(fork.modelSelection).toBeNull();
  await expect(service.start(item.id, "尚未选择")).rejects.toThrow("选择模型");
  expect(runtime.created).toBe(created);
  await service.shutdown();
  const restored = new AgentService(directory, "/launcher", () => {});
  expect((await restored.snapshot(item.id)).draft).toBe("先写草稿");
  expect((await restored.snapshot(fork.id)).messages).toEqual([]);
  await restored.shutdown();
});

it("对话独立保存模型选择，运行中的切换从下一轮生效，重启后保持独立", async (test) => {
  const directory = await mkdtemp(join(tmpdir(), "noemori-global-model-"));
  test.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const service = await configured(directory);
  const first = await createSelected(service, directory, "原有会话一");
  const second = await createSelected(service, directory, "原有会话二");
  const running = await service.start(first.id, "本轮使用旧配置");
  const created = runtime.created;
  const catalog = await service.providersSave({
    id: null,
    name: "新供应商",
    protocol: "openai-chat",
    address: { type: "base_url", url: "https://new.example/v1" },
    authentication: { type: "none" },
    models: [newProviderModel("replacement")],
  });
  const provider = catalog.providers.at(-1)!;
  await service.modelSelect(first.id, { providerId: provider.id, modelId: "replacement" });
  expect(runtime.created).toBe(created);
  expect((await service.snapshot(first.id)).model).toBe("fixture");
  expect((await service.snapshot(first.id)).run?.id).toBe(running);
  expect((await service.snapshot(second.id)).modelSelection?.modelId).toBe("fixture");
  await service.cancel(first.id, running);
  await service.start(first.id, "本轮使用新配置");
  expect(JSON.parse(runtime.configurations.at(-1)!)).toMatchObject({
    model: "replacement",
    endpoint: "https://new.example/v1/chat/completions",
  });
  await service.start(second.id, "另一条会话保留自己的模型");
  expect(JSON.parse(runtime.configurations.at(-1)!)).toMatchObject({ model: "fixture" });
  expect(runtime.created).toBe(created + 1);
  await service.shutdown();
  const restarted = new AgentService(directory, "/launcher", () => {});
  await restarted.start(first.id, "重启后继续");
  expect(JSON.parse(runtime.configurations.at(-1)!)).toMatchObject({ model: "replacement" });
  expect((await restarted.snapshot(second.id)).modelSelection?.modelId).toBe("fixture");
  await restarted.shutdown();
});

it("重启先读取历史和草稿，明确发送后才恢复原生会话，归档可以恢复继续", async (test) => {
  const directory = await mkdtemp(join(tmpdir(), "noemori-conversation-service-"));
  test.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const first = await configured(directory);
  const item = await createSelected(first, directory, "项目计划");
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
  const a = await createSelected(service, directory, "甲");
  const b = await createSelected(service, directory, "乙");
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
  const item = await createSelected(service, directory, "存储故障");
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
  const item = await createSelected(service, directory, "即将删除");
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
  const item = await createSelected(service, directory, "继续任务");
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
  const original = await createSelected(service, directory, "来源会话");
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
  const first = await createSelected(service, directory, "先前任务");
  await service.start(first.id, "第一项任务");
  clock.mockReturnValue(2000);
  const second = await createSelected(service, directory, "最近任务");
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
  await selectFixture(service, item.id);
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
  await writeFile(join(directory, "新名称.md"), `另一篇文章${marker}`);
  expect((await restored.snapshot(item.id)).article?.status).toBe("article-missing");
  await rename(join(directory, "新名称.md"), join(directory, "另一篇.md"));
  await restored.remapArticles(directory, [{ from: "新名称.md", to: "另一篇.md" }]);
  expect((await restored.snapshot(item.id)).article?.path).toBe("新名称.md");
  const fork = await restored.fork(item.id, { title: "旧文章的分支", afterTurnId: null });
  expect(fork.article?.status).toBe("article-missing");
  await restored.shutdown();
});

it.each(["anthropic", "openai-chat", "openai-responses"] as const)(
  "%s 推理强度归属单条对话，从下一轮生效并随重启恢复；未选择时省略请求参数",
  async (protocol) => {
    const directory = await mkdtemp(join(tmpdir(), "noemori-conversation-effort-"));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const service = await configured(directory);
    const catalog = await service.providersSave({
      id: null,
      name: "推理连接",
      protocol,
      address: { type: "base_url", url: "https://example.com/v1" },
      authentication: { type: "none" },
      models: [
        {
          ...newProviderModel("reasoner"),
          reasoning: { supported: true, efforts: ["low", "high"] },
        },
      ],
    });
    const providerId = catalog.providers.at(-1)!.id;
    const first = await service.create(directory, "强推理");
    const second = await service.create(directory, "服务商默认");
    await service.modelSelect(first.id, {
      providerId,
      modelId: "reasoner",
      reasoningEffort: "high",
    });
    await service.modelSelect(second.id, { providerId, modelId: "reasoner" });
    await service.modelSelect(first.id, {
      providerId,
      modelId: "reasoner",
      reasoningEffort: "max",
    });
    expect((await service.snapshot(first.id)).modelSelection?.reasoningEffort).toBe("max");
    await service.modelSelect(first.id, {
      providerId,
      modelId: "reasoner",
      reasoningEffort: "high",
    });
    const run = await service.start(first.id, "显式强度");
    expect(JSON.parse(runtime.configurations.at(-1)!)).toHaveProperty("reasoningEffort", "high");
    const starts = runtime.starts;
    await service.modelSelect(first.id, {
      providerId,
      modelId: "reasoner",
      reasoningEffort: "low",
    });
    expect(runtime.starts).toBe(starts);
    expect((await service.snapshot(first.id)).run?.id).toBe(run);
    expect(JSON.parse(runtime.configurations.at(-1)!)).toHaveProperty("reasoningEffort", "high");
    await service.cancel(first.id, run);
    await service.start(first.id, "下一轮使用新强度");
    expect(JSON.parse(runtime.configurations.at(-1)!)).toHaveProperty("reasoningEffort", "low");
    await service.start(second.id, "服务商默认");
    expect(JSON.parse(runtime.configurations.at(-1)!)).not.toHaveProperty("reasoningEffort");
    await service.shutdown();
    const restored = new AgentService(directory, "/launcher", () => {});
    await restored.start(first.id, "重启后保持强度");
    expect(JSON.parse(runtime.configurations.at(-1)!)).toHaveProperty("reasoningEffort", "low");
    await restored.shutdown();
  },
);

it("选择写盘失败保留旧选择，运行进度通知不能将已保存的新选择覆盖回去", async (test) => {
  const { ConversationStore } =
    await import("../../../../modules/notes/packages/desktop/src/features/agent/main/conversations");
  const directory = await mkdtemp(join(tmpdir(), "noemori-model-transaction-"));
  test.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const service = await configured(directory);
  const item = await createSelected(service, directory, "正在运行");
  await service.start(item.id, "进度持续到达");
  const provider = (
    await service.providersSave({
      id: null,
      name: "替换连接",
      protocol: "openai-chat",
      address: { type: "base_url", url: "https://example.com/v1" },
      authentication: { type: "none" },
      models: [newProviderModel("replacement")],
    })
  ).providers.at(-1)!;
  const selection = { providerId: provider.id, modelId: "replacement" };
  const original = ConversationStore.prototype.save;
  const save = vi.spyOn(ConversationStore.prototype, "save");
  test.onTestFinished(() => save.mockRestore());
  save.mockRejectedValueOnce(new Error("选择保存失败"));
  await expect(service.modelSelect(item.id, selection)).rejects.toThrow("选择保存失败");
  expect((await service.snapshot(item.id)).modelSelection?.modelId).toBe("fixture");
  const entered = Promise.withResolvers<void>();
  const complete = Promise.withResolvers<void>();
  save.mockImplementationOnce(async function (this: InstanceType<typeof ConversationStore>, next) {
    entered.resolve();
    await complete.promise;
    await original.call(this, next);
  });
  const selecting = service.modelSelect(item.id, selection);
  await entered.promise;
  runtime.notify();
  await new Promise((resolve) => setTimeout(resolve, 250));
  complete.resolve();
  await selecting;
  await service.flush();
  expect(
    JSON.parse(await readFile(join(directory, "conversations", `${item.id}.json`), "utf8"))
      .modelSelection,
  ).toEqual(selection);
  await service.shutdown();
});

it("模型被移除后保留历史和草稿，发送明确拒绝且不替换为另一个供应商", async (test) => {
  const directory = await mkdtemp(join(tmpdir(), "noemori-dangling-model-"));
  test.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const service = await configured(directory);
  const item = await createSelected(service, directory, "失效的选择");
  await service.saveDraft(item.id, "保留草稿");
  const before = runtime.starts;
  await service.providersRemove((await service.providersGet()).providers[0]!.id);
  await expect(service.start(item.id, "不能发送")).rejects.toThrow("重新选择模型");
  expect(runtime.starts).toBe(before);
  expect((await service.snapshot(item.id)).draft).toBe("保留草稿");
  await service.shutdown();
});

it("旧版历史从已确认的全局选择迁入，保存后不再受旧默认变动影响", async (test) => {
  const directory = await mkdtemp(join(tmpdir(), "noemori-legacy-selection-"));
  test.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const service = await configured(directory);
  const item = await createSelected(service, directory, "旧对话");
  await service.start(item.id, "历史消息");
  await service.shutdown();
  const conversationFile = join(directory, "conversations", `${item.id}.json`);
  const saved = record(JSON.parse(await readFile(conversationFile, "utf8")));
  saved["version"] = 4;
  delete saved["modelSelection"];
  await writeFile(conversationFile, JSON.stringify(saved));
  const providerFile = join(directory, "agent-model.json");
  const catalog = record(JSON.parse(await readFile(providerFile, "utf8")));
  catalog["active"] = item.modelSelection;
  await writeFile(providerFile, JSON.stringify(catalog));
  const restored = new AgentService(directory, "/launcher", () => {});
  expect((await restored.snapshot(item.id)).modelSelection?.modelId).toBe("fixture");
  await restored.shutdown();
  catalog["active"] = null;
  await writeFile(providerFile, JSON.stringify(catalog));
  const next = new AgentService(directory, "/launcher", () => {});
  expect((await next.snapshot(item.id)).modelSelection?.modelId).toBe("fixture");
  await next.shutdown();
});
