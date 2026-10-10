import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentProviderStore } from "../../../../modules/notes/packages/desktop/src/features/agent/main/providers";
import { encryptAuthentication } from "../../../../modules/notes/packages/desktop/src/features/agent/main/settings";
import {
  newProviderModel,
  type ProviderUpdate,
  type ModelSelection,
} from "../../../../modules/notes/packages/desktop/src/features/agent/shared/providers";

const encryption = vi.hoisted(() => ({ available: true }));
vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => encryption.available,
    encryptString: (value: string) => Buffer.from(value).map((byte) => byte ^ 0x5a),
    decryptString: (value: Buffer) => {
      if (!encryption.available) throw new Error("安全存储不可用");
      return Buffer.from(value)
        .map((byte) => byte ^ 0x5a)
        .toString();
    },
  },
}));
beforeEach(() => {
  encryption.available = true;
});
afterEach(() => vi.unstubAllGlobals());

function provider(name: string, secret = "private-api-secret"): ProviderUpdate {
  return {
    id: null,
    name,
    protocol: "openai-chat",
    address: { type: "base_url", url: "https://example.com/v1" },
    authentication: { type: "bearer", value: secret },
    models: [newProviderModel("fixture"), newProviderModel("second")],
  };
}
async function store(test: { onTestFinished: (fn: () => Promise<void>) => void }) {
  const directory = await mkdtemp(join(tmpdir(), "agent-providers-"));
  test.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  return { store: new AgentProviderStore(directory), directory };
}

async function choice(settings: AgentProviderStore, modelId?: string): Promise<ModelSelection> {
  const provider = (await settings.catalog()).providers[0]!;
  return { providerId: provider.id, modelId: modelId ?? provider.models[0]!.id };
}
async function selected(settings: AgentProviderStore) {
  return settings.selected(await choice(settings));
}

it("只保存连接不要求模型，空目录也不会隐式选择模型", async (test) => {
  const { store: settings, directory } = await store(test);
  const catalog = await settings.save({ ...provider("待获取模型的连接"), models: [] });
  expect(catalog.providers[0]?.models).toEqual([]);
  expect(await settings.legacySelection()).toBeNull();
  expect(await new AgentProviderStore(directory).catalog()).toEqual(catalog);
  expect(await settings.selected(null)).toBeNull();
});

it("多供应商独立保存密钥，模型解析严格按显式身份且公开读取不需要解密", async (test) => {
  const { store: settings, directory } = await store(test);
  expect(await settings.catalog()).toEqual({ providers: [] });
  let catalog = await settings.save(provider("账号一", "first-secret"));
  const first = catalog.providers[0]!;
  expect(await settings.legacySelection()).toBeNull();
  catalog = await settings.save(provider("账号二", "second-secret"));
  const second = catalog.providers[1]!;
  expect(
    (await new AgentProviderStore(directory).selected({ providerId: second.id, modelId: "second" }))
      ?.settings.authentication,
  ).toEqual({
    type: "bearer",
    value: "second-secret",
  });
  await settings.save({ ...provider("账号一改名"), id: first.id, authentication: null });
  expect((await selected(settings))?.settings.authentication).toEqual({
    type: "bearer",
    value: "first-secret",
  });
  encryption.available = false;
  expect(JSON.stringify(await settings.catalog())).not.toContain("secret");
  expect((await settings.public(await choice(settings)))?.authentication.type).toBe("bearer");
  await expect(selected(settings)).rejects.toThrow("安全存储");
  const disk = await readFile(join(directory, "agent-model.json"), "utf8");
  expect(disk).not.toContain("first-secret");
  expect(disk).not.toContain("second-secret");
});

it("发现模型只在主进程解密当前连接，发现不保存也不改变默认模型", async (test) => {
  const { store: settings, directory } = await store(test);
  const saved = (await settings.save(provider("账号", "saved-secret"))).providers[0]!;
  const file = join(directory, "agent-model.json"),
    before = await readFile(file, "utf8");
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({ data: [{ id: "discovered" }] }),
  );
  vi.stubGlobal("fetch", fetch);
  const connection = { ...saved, authentication: null };
  const discovered = await settings.discover(connection);
  expect(new Headers(fetch.mock.calls[0]![1]?.headers).get("authorization")).toBe(
    "Bearer saved-secret",
  );
  expect(discovered[0]?.id).toBe("discovered");
  expect(JSON.stringify(discovered)).not.toContain("saved-secret");
  expect(await readFile(file, "utf8")).toBe(before);
  await expect(settings.discover({ ...connection, id: "missing" })).rejects.toThrow("不存在");
  await expect(
    settings.discover({
      ...connection,
      address: { type: "base_url", url: "https://other.example/v1" },
    }),
  ).rejects.toThrow("重新输入");
  expect(fetch).toHaveBeenCalledOnce();
});

it("已发现的推理能力可供对话选择，原生配置只包含选择值，不携带模型元数据", async (test) => {
  const { store: settings, directory } = await store(test);
  await settings.save({
    ...provider("推理模型"),
    protocol: "anthropic",
    models: [
      {
        ...newProviderModel("reasoner"),
        reasoning: { supported: true, efforts: ["low", "high"] },
      },
    ],
  });
  const savedProvider = (await settings.catalog()).providers[0]!;
  const resolved = await new AgentProviderStore(directory).selected({
    providerId: savedProvider.id,
    modelId: "reasoner",
    reasoningEffort: "high",
  });
  expect(resolved?.settings.reasoningEffort).toBe("high");
  expect(resolved?.settings).not.toHaveProperty("reasoning");
  const saved = (await settings.catalog()).providers[0]!;
  expect(saved.models[0]?.reasoning?.efforts).toEqual(["low", "high"]);
  await settings.save({
    ...saved,
    authentication: null,
    models: [{ ...saved.models[0], reasoningEffort: "max" }],
  });
  expect((await settings.catalog()).providers[0]?.models[0]?.reasoningEffort).toBe("max");
});

it("模型归属由实际连接决定，改名和添加未选模型保留签名，连接变化重新绑定", async (test) => {
  const { store: settings, directory } = await store(test);
  const saved = (await settings.save(provider("原名称"))).providers[0]!;
  const binding = (await selected(settings))!.binding;
  await settings.save({
    ...saved,
    name: "新名称",
    models: [...saved.models, newProviderModel("unused")],
    authentication: null,
  });
  expect((await selected(settings))!.binding).toBe(binding);
  const file = join(directory, "agent-model.json");
  const raw = JSON.parse(await readFile(file, "utf8"));
  raw.providers[0].provider.address.url = "https://changed.example/v1";
  await writeFile(file, JSON.stringify(raw));
  const routed = (await selected(settings))!.binding;
  expect(routed).not.toBe(binding);
  raw.providers[0].encrypted = encryptAuthentication({ type: "bearer", value: "another-account" });
  await writeFile(file, JSON.stringify(raw));
  expect((await selected(settings))!.binding).not.toBe(routed);
});

it.each<ProviderUpdate["protocol"]>([
  "openai-responses",
  "anthropic",
  "vertex-anthropic",
  "gemini",
  "ollama",
  "bedrock",
])("相同地址与模型切换到 %s 仍更新历史归属", async (protocol) => {
  const { store: settings } = await store({ onTestFinished });
  const saved = (
    await settings.save({
      ...provider("同一连接"),
      address: { type: "endpoint", url: "https://example.com/model" },
      models: [newProviderModel("fixture")],
    })
  ).providers[0]!;
  const prior = (await selected(settings))!;
  await settings.save({ ...saved, protocol, authentication: null });
  const switched = (await selected(settings))!;
  expect(switched.settings.protocol).toBe(protocol);
  expect(switched.settings.endpoint).toBe(prior.settings.endpoint);
  expect(switched.settings.model).toBe(prior.settings.model);
  expect(switched.binding).not.toBe(prior.binding);
  expect((await selected(settings))!.binding).toBe(switched.binding);
});

it.each(["描述不一致", "空认证材料"])("磁盘认证%s在派发模型前被拒绝", async (reason) => {
  const { store: settings, directory } = await store({ onTestFinished });
  await settings.save(provider("账号"));
  const file = join(directory, "agent-model.json");
  const raw = JSON.parse(await readFile(file, "utf8"));
  if (reason === "描述不一致") {
    raw.providers[0].provider.authentication = {
      type: "header",
      configured: true,
      name: "x-api-key",
      region: "",
    };
  } else {
    raw.providers[0].encrypted = encryptAuthentication({ type: "bearer", value: "" });
  }
  await writeFile(file, JSON.stringify(raw));
  await expect(selected(settings)).rejects.toThrow("认证");
});

it("保存和选择在接收调用时固定输入，排队期间的调用端修改不能改变已确认动作", async (test) => {
  const { store: settings } = await store(test);
  const input = provider("原始名称");
  const saving = settings.save(input);
  input.name = "迟到名称";
  input.models[0]!.id = "迟到模型";
  const saved = await saving;
  expect(saved.providers[0]!.name).toBe("原始名称");
  expect(saved.providers[0]!.models[0]!.id).toBe("fixture");
  const selection = { providerId: saved.providers[0]!.id, modelId: "fixture" };
  const selecting = settings.selected(selection);
  selection.modelId = "second";
  expect((await selecting)?.settings.model).toBe("fixture");
});

it("目录语法错误不把系统密文片段写进公开错误", async (test) => {
  const { store: settings, directory } = await store(test);
  await writeFile(join(directory, "agent-model.json"), "private-ciphertext-fragment");
  await expect(settings.catalog()).rejects.toThrow("供应商配置格式无效");
});

it("允许的中文模型标识不会因 UTF-8 身份长度在原生边界失败", async (test) => {
  const { store: settings } = await store(test);
  await settings.save({ ...provider("中文标识"), models: [newProviderModel("模型".repeat(3000))] });
  const resolved = (await selected(settings))!;
  expect(resolved.settings.model).toBe("模型".repeat(3000));
  expect(Buffer.byteLength(resolved.binding)).toBeLessThanOrEqual(16 * 1024);
});

it("删除或移除模型会使原选择失效，不自动切换账号；失败不修改已保存配置", async (test) => {
  const { store: settings, directory } = await store(test);
  const first = (await settings.save(provider("账号一"))).providers[0]!;
  await settings.save(provider("账号二"));
  await expect(settings.selected({ providerId: first.id, modelId: "missing" })).rejects.toThrow(
    "模型",
  );
  await settings.save({
    ...provider("账号一"),
    id: first.id,
    authentication: null,
    models: [newProviderModel("second")],
  });
  await expect(settings.selected({ providerId: first.id, modelId: "fixture" })).rejects.toThrow(
    "重新选择",
  );
  await settings.selected({ providerId: first.id, modelId: "second" });
  const before = await readFile(join(directory, "agent-model.json"), "utf8");
  encryption.available = false;
  await expect(settings.save(provider("账号三"))).rejects.toThrow("安全存储");
  expect(await readFile(join(directory, "agent-model.json"), "utf8")).toBe(before);
  await settings.remove(first.id);
  await expect(settings.selected({ providerId: first.id, modelId: "second" })).rejects.toThrow(
    "重新选择",
  );
});

it("串行变更不覆盖其他供应商，保留密钥不能跨供应商或跨来源", async (test) => {
  const { store: settings } = await store(test);
  await Promise.all([settings.save(provider("一")), settings.save(provider("二"))]);
  const first = (await settings.catalog()).providers[0]!;
  await expect(
    settings.save({ ...provider("未知"), id: "missing", authentication: null }),
  ).rejects.toThrow("不存在");
  await expect(
    settings.save({
      ...provider("一"),
      id: first.id,
      authentication: null,
      address: { type: "base_url", url: "https://other.example/v1" },
    }),
  ).rejects.toThrow("重新输入");
  expect((await settings.catalog()).providers).toHaveLength(2);
});

it("旧版单模型迁为独立供应商，认证、完整地址与能力保留", async (test) => {
  const { store: settings, directory } = await store(test);
  const model = {
    protocol: "openai-chat" as const,
    model: "legacy",
    endpoint: "https://example.com/deploy?version=1",
    authentication: { type: "bearer" as const, value: "legacy-secret" },
    tools: true,
    streaming: false,
    vision: false,
    audio: false,
    video: false,
  };
  const { authentication, ...legacySettings } = model;
  await writeFile(
    join(directory, "agent-model.json"),
    JSON.stringify({
      version: 1,
      settings: legacySettings,
      authentication: encryptAuthentication(authentication),
    }),
  );
  expect((await selected(settings))?.settings).toEqual(model);
  const migrated = (await settings.catalog()).providers[0]!;
  expect(migrated.address).toEqual({ type: "endpoint", url: model.endpoint });
  await settings.save({ ...migrated, authentication: null });
  expect(JSON.parse(await readFile(join(directory, "agent-model.json"), "utf8")).version).toBe(2);
  expect((await selected(settings))?.settings.authentication).toEqual(model.authentication);
});

it("迁移旧版全局选择时保留显式推理档位，不依赖能力元数据", async (test) => {
  const { store: settings, directory } = await store(test);
  const saved = (
    await settings.save({
      ...provider("旧连接"),
      authentication: { type: "none" },
      models: [
        {
          ...newProviderModel("fixture"),
          reasoning: { supported: false, efforts: [] },
          reasoningEffort: "max",
        },
      ],
    })
  ).providers[0]!;
  const selection = { providerId: saved.id, modelId: "fixture" };
  await writeFile(
    join(directory, "agent-model.json"),
    JSON.stringify({
      version: 2,
      providers: [{ provider: saved, encrypted: null }],
      active: selection,
    }),
  );
  expect(await new AgentProviderStore(directory).legacySelection()).toEqual({
    ...selection,
    reasoningEffort: "max",
  });
});

it("旧格式迁移的模型归属隔离不同账号，避免随库迁移的私有签名被交给另一账号", async (test) => {
  const first = await store(test),
    second = await store(test);
  const legacySettings = {
    protocol: "openai-chat",
    model: "fixture",
    endpoint: "https://example.com/chat",
    tools: true,
    streaming: true,
    vision: false,
    audio: false,
    video: false,
  };
  for (const [index, target] of [first, second].entries()) {
    await writeFile(
      join(target.directory, "agent-model.json"),
      JSON.stringify({
        version: 1,
        settings: legacySettings,
        authentication: encryptAuthentication({ type: "bearer", value: `account-${index}` }),
      }),
    );
  }
  const firstBinding = (await selected(first.store))!.binding;
  expect(firstBinding).not.toBe((await selected(second.store))!.binding);
  expect(firstBinding).toBe((await selected(first.store))!.binding);
  expect(firstBinding).not.toContain("account-0");
});

it("刷新保存完整模型目录，连接在网络等待期间改变时拒绝旧目录", async (test) => {
  const { store: settings } = await store(test);
  const saved = (await settings.save({ ...provider("连接"), models: [] })).providers[0]!;
  const waiting = Promise.withResolvers<Response>();
  const called = Promise.withResolvers<void>();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      called.resolve();
      return waiting.promise;
    }),
  );
  const refreshing = settings.refresh(saved.id);
  await called.promise;
  await settings.save({
    ...saved,
    authentication: { type: "bearer", value: "new-key" },
    models: [],
  });
  waiting.resolve(Response.json({ data: [{ id: "old-model" }] }));
  await expect(refreshing).rejects.toThrow("连接已改变");
  expect((await settings.catalog()).providers[0]?.models).toEqual([]);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ data: [{ id: "one" }, { id: "two" }] })),
  );
  const result = await settings.refresh(saved.id);
  expect(result.providers[0]?.models.map((model) => model.id)).toEqual(["one", "two"]);
  expect(await settings.legacySelection()).toBeNull();
});
