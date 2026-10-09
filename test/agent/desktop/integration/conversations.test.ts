import { expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  ConversationStore,
  type ConversationRecord,
} from "../../../../modules/notes/packages/desktop/src/features/agent/main/conversations";
import { encryptAuthentication } from "../../../../modules/notes/packages/desktop/src/features/agent/main/settings";

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
