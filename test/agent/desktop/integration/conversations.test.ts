import { expect, it, onTestFinished, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import * as files from "node:fs/promises";
import * as crypto from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  ConversationStore,
  type ConversationRecord,
} from "../../../../modules/notes/packages/desktop/src/features/agent/main/conversations";
import { encryptAuthentication } from "../../../../modules/notes/packages/desktop/src/features/agent/main/settings";

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
}));
vi.mock("node:crypto", async (original) => ({
  ...(await original<typeof import("node:crypto")>()),
}));

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value).map((byte) => byte ^ 0x5a),
    decryptString: (value: Buffer) =>
      Buffer.from(value)
        .map((byte) => byte ^ 0x5a)
        .toString(),
  },
}));

function conversation(): ConversationRecord {
  const id = randomUUID();
  return {
    id,
    title: "研究计划",
    createdAt: 1,
    updatedAt: 2,
    archived: false,
    origin: null,
    article: null,
    linkedWorkspace: "/workspace",
    draft: "继续整理",
    queue: { messages: [], paused: false, error: null },
    model: "fixture",
    modelSelection: { providerId: "provider", modelId: "fixture", reasoningEffort: "high" },
    checkpoint: JSON.stringify({ version: 1, workspace: "/workspace", history: [] }),
    snapshot: {
      id,
      workspace: "/workspace",
      revision: 1,
      closed: false,
      run: null,
      turns: [],
      messages: [{ role: "user", content: [{ type: "text", value: "研究计划" }] }],
      approvals: [],
      terminals: [],
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
    },
  };
}

it("原生第三版检查点可恢复历史，未知版本和工作区不一致仍被拒绝", async (test) => {
  const directory = await mkdtemp(join(tmpdir(), "noemori-checkpoint-version-"));
  test.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const store = new ConversationStore(directory), item = conversation();
  item.checkpoint = JSON.stringify({ version: 3, workspace: item.snapshot.workspace, history: [], pending_turn: null });
  await store.save(item);
  expect((await store.load()).records).toEqual([item]);
  for (const checkpoint of [{ version: 4, workspace: item.snapshot.workspace }, { version: 3, workspace: "/other" }]) {
    await store.save({ ...item, checkpoint: JSON.stringify(checkpoint) });
    expect((await store.load()).records).toEqual([]);
    expect((await store.load()).issues[0]).toContain("版本或工作目录不一致");
  }
});

it("会话临时文件被占用时保留占用者内容和旧记录，不删除未取得所有权的路径", async (test) => {
  const directory = await mkdtemp(join(tmpdir(), "noemori-conversation-temp-collision-"));
  test.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const store = new ConversationStore(directory);
  const item = conversation();
  await store.save(item);
  const identity = "11111111-1111-4111-8111-111111111111";
  const temporary = join(directory, "conversations", `${item.id}.json.${identity}.tmp`);
  await writeFile(temporary, "另一个操作持有的内容");
  const uuid = vi.spyOn(crypto, "randomUUID").mockReturnValueOnce(identity);
  test.onTestFinished(() => uuid.mockRestore());

  await expect(store.save({ ...item, title: "未提交标题" })).rejects.toMatchObject({
    code: "EEXIST",
  });
  expect(await readFile(temporary, "utf8")).toBe("另一个操作持有的内容");
  expect((await store.load()).records).toEqual([item]);
});

it.each([false, true])(
  "会话替换失败保留旧记录，回滚也失败=%s 时交付两处原因",
  async (cleanupFails) => {
    const directory = await mkdtemp(join(tmpdir(), "noemori-conversation-rollback-"));
    const store = new ConversationStore(directory);
    const item = conversation();
    await store.save(item);
    const failure = new Error("会话替换失败");
    const cleanup = new Error("会话临时文件清理失败");
    const rename = vi.spyOn(files, "rename").mockRejectedValueOnce(failure);
    const remove = cleanupFails ? vi.spyOn(files, "rm").mockRejectedValueOnce(cleanup) : null;
    onTestFinished(async () => {
      rename.mockRestore();
      remove?.mockRestore();
      await rm(directory, { recursive: true, force: true });
    });
    const saving = store.save({ ...item, title: "未提交标题" });
    if (cleanupFails) await expect(saving).rejects.toMatchObject({ errors: [failure, cleanup] });
    else await expect(saving).rejects.toBe(failure);
    expect((await store.load()).records).toEqual([item]);
    expect(await readdir(join(directory, "conversations"))).toHaveLength(cleanupFails ? 2 : 1);
    await store.save({ ...item, title: "下一次正常保存" });
    expect((await store.load()).records[0]?.title).toBe("下一次正常保存");
  },
);

it("原子替换完成后没有临时路径所有权，不因多余清理伪报保存失败", async (test) => {
  const directory = await mkdtemp(join(tmpdir(), "noemori-conversation-commit-"));
  test.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const store = new ConversationStore(directory);
  const item = conversation();
  const remove = vi.spyOn(files, "rm").mockRejectedValueOnce(new Error("不应执行清理"));
  test.onTestFinished(() => remove.mockRestore());

  await store.save(item);
  expect(remove).not.toHaveBeenCalled();
  expect((await store.load()).records).toEqual([item]);
  expect(await readdir(join(directory, "conversations"))).toEqual([`${item.id}.json`]);
});

it("旧凭据清理失败发生在会话提交之前，保存拒绝时仍保留上一份记录", async (test) => {
  const directory = await mkdtemp(join(tmpdir(), "noemori-conversation-credentials-"));
  test.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const credentials = join(directory, "credentials");
  const store = new ConversationStore(directory, credentials);
  const item = conversation();
  await store.save(item);
  // 无法按凭据文件删除的占用目录代表清理失败，不让测试依赖宿主权限差异。
  await mkdir(join(credentials, `${item.id}.json`), { recursive: true });

  await expect(store.save({ ...item, title: "不应提交的标题" })).rejects.toThrow();
  expect((await store.load()).records).toEqual([item]);
});

it.each(["write", "close", "both"])(
  "JSON %s 失败时关闭句柄、清理部分副本并保留旧会话",
  async (phase) => {
    const directory = await mkdtemp(join(tmpdir(), "noemori-conversation-write-failure-"));
    const store = new ConversationStore(directory);
    const item = conversation();
    await store.save(item);
    const open = files.open;
    const writing = new Error("JSON 内容写入失败");
    const closing = new Error("JSON 句柄关闭失败");
    let closes = 0;
    const opening = vi.spyOn(files, "open").mockImplementationOnce(async (...args) => {
      const handle = await open(...args);
      const write = handle.writeFile.bind(handle);
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "writeFile").mockImplementationOnce(async (content) => {
        await write(content);
        if (phase !== "close") throw writing;
      });
      vi.spyOn(handle, "close").mockImplementationOnce(async () => {
        closes += 1;
        await close();
        if (phase !== "write") throw closing;
      });
      return handle;
    });
    onTestFinished(async () => {
      opening.mockRestore();
      await rm(directory, { recursive: true, force: true });
    });

    const saving = store.save({ ...item, title: "写入途中失败" });
    if (phase === "both")
      await expect(saving).rejects.toMatchObject({ errors: [writing, closing] });
    else await expect(saving).rejects.toBe(phase === "write" ? writing : closing);
    expect(closes).toBe(1);
    expect((await store.load()).records).toEqual([item]);
    expect(await readdir(join(directory, "conversations"))).toEqual([`${item.id}.json`]);
  },
);

it.each([1, 2, 3, 4, 5, 6, 7, 8, 9])(
  "版本 %s 的会话只恢复该版本声明的字段和模型选择",
  async (version) => {
    const directory = await mkdtemp(join(tmpdir(), "noemori-conversation-versions-"));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const store = new ConversationStore(directory);
    const item = conversation();
    item.origin = { conversationId: randomUUID(), title: "来源会话", turnId: null };
    item.article = { path: "文章.md", markerId: item.id, title: "文章" };
    item.queue.messages = [{ id: "pending", text: "待发送追问", state: "queued" }];
    item.draftReferences = [{ id: "quoted", text: "原文引用", source: null }];
    item.attachments = [
      { id: randomUUID(), name: "资料.txt", size: 12, sha256: "a".repeat(64), image: null },
    ];
    item.draftAttachmentIds = item.attachments.map((file) => file.id);
    await store.save(item);
    const expected: ConversationRecord = {
      ...item,
      origin: version >= 2 ? item.origin : null,
      article: version >= 3 ? item.article : null,
      modelSelection: version >= 5 ? item.modelSelection : null,
      queue: version >= 7 ? item.queue : { messages: [], paused: false, error: null },
    };
    if (version < 8) delete expected.draftReferences;
    if (version < 9) {
      delete expected.attachments;
      delete expected.draftAttachmentIds;
    }
    const stored = structuredClone(item);
    if (version === 1) {
      Reflect.deleteProperty(stored.snapshot, "turns");
      Reflect.deleteProperty(stored, "origin");
    }
    if (version < 3) Reflect.deleteProperty(stored, "article");
    if (version < 5) Reflect.deleteProperty(stored, "modelSelection");
    if (version < 6) Reflect.deleteProperty(stored, "linkedWorkspace");
    if (version < 7) Reflect.deleteProperty(stored, "queue");
    if (version < 8) Reflect.deleteProperty(stored, "draftReferences");
    if (version < 9) {
      Reflect.deleteProperty(stored, "attachments");
      Reflect.deleteProperty(stored, "draftAttachmentIds");
    }
    await writeFile(
      join(directory, "conversations", `${item.id}.json`),
      JSON.stringify({
        ...stored,
        version,
        model:
          version >= 4 ? item.model : { settings: { model: item.model }, authentication: "旧密文" },
      }),
    );

    expect(await store.load()).toEqual({
      records: [expected],
      issues: [],
      legacyIds: version < 5 ? [item.id] : [],
    });
  },
);

it("引用与草稿共同恢复，损坏引用保留记录并报告，不把来源变成目录关联", async (test) => {
  const directory = await mkdtemp(join(tmpdir(), "noemori-reference-storage-"));
  test.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const store = new ConversationStore(directory);
  const item = conversation();
  item.draftReferences = [{ id: "quote", text: "原文😀", source: { root: "/other-vault", path: "资料/原文.md", offset: 0, sourceText: "原文😀" } }];
  await store.save(item);
  expect((await new ConversationStore(directory).load()).records).toEqual([item]);
  const path = join(directory, "conversations", `${item.id}.json`);
  await writeFile(path, JSON.stringify({ ...item, version: 8, draftReferences: [{ ...item.draftReferences[0], source: { root: "/other-vault", path: "../原文.md", offset: 0, sourceText: "原文😀" } }] }));
  expect((await store.load()).issues[0]).toContain("引用来源无效");
  expect(await readFile(path, "utf8")).toContain("原文😀");
});

it("独立保存记录、归档与草稿，会话只保存最后使用的模型标识", async (test) => {
  const directory = await mkdtemp(join(tmpdir(), "noemori-conversations-"));
  test.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const store = new ConversationStore(directory);
  const item = conversation();
  await store.save(item);
  await store.save({ ...item, title: "新标题", archived: true, updatedAt: 3 });
  const loaded = await new ConversationStore(directory).load();
  expect(loaded.issues).toEqual([]);
  expect(loaded.records).toEqual([{ ...item, title: "新标题", archived: true, updatedAt: 3 }]);
  expect(await readFile(join(directory, "conversations", `${item.id}.json`), "utf8")).not.toContain(
    "private-session-key",
  );
  expect(loaded.records[0]!.model).toBe("fixture");
});

it("新版保存有界追问队列，旧版迁移为空队列，非法队列保留文件并报告错误", async (test) => {
  const directory = await mkdtemp(join(tmpdir(), "noemori-conversation-queue-"));
  test.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const store = new ConversationStore(directory), item = conversation();
  item.queue = { messages: [{ id: "next", text: "待发送追问", state: "sending" }], paused: true, error: "待核对" };
  await store.save(item);
  expect((await store.load()).records[0]!.queue).toEqual(item.queue);
  const path = join(directory, "conversations", `${item.id}.json`);
  const legacy = { ...item, version: 6 };
  Reflect.deleteProperty(legacy, "queue");
  await writeFile(path, JSON.stringify(legacy));
  expect((await store.load()).records[0]!.queue.messages).toEqual([]);
  await writeFile(path, JSON.stringify({ ...item, version: 7, queue: { ...item.queue, messages: [...item.queue.messages, ...item.queue.messages] } }));
  expect((await store.load()).issues[0]).toContain("追问标识重复");
  expect(await readFile(path, "utf8")).toContain("待发送追问");
});

it("排队删除不会被之前的写入复活，损坏记录保留并明确上报", async (test) => {
  const directory = await mkdtemp(join(tmpdir(), "noemori-conversations-"));
  test.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const store = new ConversationStore(directory);
  const first = conversation();
  const second = conversation();
  await Promise.all([store.save(first), store.save(second), store.remove(first.id)]);
  const broken = `${randomUUID()}.json`;
  await writeFile(join(directory, "conversations", broken), "broken");
  const loaded = await store.load();
  expect(loaded.records.map((item) => item.id)).toEqual([second.id]);
  expect(loaded.issues).toHaveLength(1);
  expect(loaded.issues[0]).toContain(broken);
  expect(await readdir(join(directory, "conversations"))).toHaveLength(2);
});

it("旧版无轮次记录原样保留消息，升级时不推断虚假的分叉边界", async (test) => {
  const directory = await mkdtemp(join(tmpdir(), "noemori-conversations-v1-"));
  test.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const store = new ConversationStore(directory);
  const item = conversation();
  await store.save(item);
  const legacy = structuredClone(item);
  Reflect.deleteProperty(legacy, "origin");
  Reflect.deleteProperty(legacy.snapshot, "turns");
  await writeFile(
    join(directory, "conversations", `${item.id}.json`),
    JSON.stringify({
      version: 1,
      ...legacy,
      model: {
        settings: {
          protocol: "openai-chat",
          model: "fixture",
          endpoint: "https://example.com/chat",
          tools: true,
          streaming: true,
          vision: false,
          audio: false,
          video: false,
        },
        authentication: encryptAuthentication({ type: "bearer", value: "private-session-key" }),
      },
    }),
  );
  const loaded = await store.load();
  expect(loaded.issues).toEqual([]);
  expect(loaded.records).toEqual([{ ...item, modelSelection: null }]);
  expect(loaded.legacyIds).toEqual([item.id]);
});

it("文章历史随库保存且不携带认证，迁入另一设备后保留选择身份等待显式重选", async (test) => {
  const directory = await mkdtemp(join(tmpdir(), "noemori-article-store-"));
  test.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const item = conversation();
  item.article = { path: "文章.md", title: "文章", markerId: item.id };
  const store = new ConversationStore(join(directory, "vault"), join(directory, "local"));
  await store.save(item);
  const disk = await readFile(join(directory, "vault", "conversations", `${item.id}.json`), "utf8");
  expect(disk).not.toContain("private-session-key");
  expect((await store.load()).records).toEqual([item]);
  const migrated = await new ConversationStore(
    join(directory, "vault"),
    join(directory, "another-device"),
  ).load();
  expect(migrated.issues).toEqual([]);
  expect(migrated.records[0]?.article).toEqual(item.article);
  expect(migrated.records[0]?.model).toBe("fixture");
});

it("未运行对话以空检查点保存选择和草稿，已有历史缺少检查点则拒绝", async (test) => {
  const directory = await mkdtemp(join(tmpdir(), "noemori-empty-conversation-"));
  test.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const store = new ConversationStore(directory);
  const item = conversation();
  item.model = null;
  item.checkpoint = null;
  item.snapshot.messages = [];
  await store.save(item);
  expect((await store.load()).records).toEqual([item]);
  item.snapshot.messages.push({ role: "user", content: [{ type: "text", value: "不能丢失" }] });
  await store.save(item);
  expect((await store.load()).issues[0]).toContain("不能缺少检查点");
});

it("旧版已有目录的对话保留显式关联，不把已保存模型选择当作待迁移默认", async (test) => {
  const directory = await mkdtemp(join(tmpdir(), "noemori-conversation-v5-"));
  test.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const store = new ConversationStore(directory);
  const item = conversation();
  await store.save(item);
  const saved = { version: 5, ...item };
  Reflect.deleteProperty(saved, "linkedWorkspace");
  await writeFile(join(directory, "conversations", `${item.id}.json`), JSON.stringify(saved));
  const loaded = await store.load();
  expect(loaded.issues).toEqual([]);
  expect(loaded.records).toEqual([item]);
  expect(loaded.legacyIds).toEqual([]);
});
