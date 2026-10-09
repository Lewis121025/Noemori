/** @vitest-environment jsdom */
import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, it, vi } from "vitest";
import ModelSettings from "../../../../modules/notes/packages/desktop/src/features/agent/renderer/ModelSettings.svelte";
import {
  parseProviderUpdate,
  newProviderModel,
  type DiscoveredModel,
  type ProviderCatalog,
  type PublicProvider,
} from "../../../../modules/notes/packages/desktop/src/features/agent/shared/providers";
import { createAgentApiMock } from "../../../notes/desktop/fixtures/agent-api-mock";

let component: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement;
afterEach(async () => {
  if (component) await unmount(component);
  target?.remove();
});
function provider(id: string, name: string): PublicProvider {
  return {
    id,
    name,
    protocol: "openai-chat",
    address: { type: "base_url", url: "https://example.com/v1" },
    authentication: { type: "bearer", configured: true, name: "", region: "" },
    models: [newProviderModel("fixture")],
  };
}
async function setup(initial: ProviderCatalog = { providers: [] }) {
  target = document.createElement("div");
  document.body.append(target);
  let catalog = initial;
  const api = createAgentApiMock();
  api.providersGet = vi.fn(async () => catalog);
  api.providersDiscover = vi.fn<typeof api.providersDiscover>(async () =>
    ["fixture", "gemini-fixture", "second-model"].map((id): DiscoveredModel => ({
      ...newProviderModel(id),
      name: id,
      reasoning: { supported: null, efforts: null },
    })),
  );
  api.providersSave = vi.fn(async (value) => {
    // Electron IPC 使用结构化复制，测试也必须拒绝残留的响应式代理。
    structuredClone(value);
    const input = parseProviderUpdate(value);
    const id = input.id ?? `provider-${catalog.providers.length}`;
    const prior = catalog.providers.find((item) => item.id === id);
    const auth = input.authentication;
    const item: PublicProvider = {
      ...input,
      id,
      authentication:
        auth === null
          ? prior!.authentication
          : {
              type: auth.type,
              configured: auth.type !== "none",
              name: auth.type === "header" ? auth.name : "",
              region: auth.type === "aws" ? auth.region : "",
            },
    };
    catalog = {
      providers: [...catalog.providers.filter((item) => item.id !== id), item],
    };
    return catalog;
  });
  api.modelSelect = vi.fn();
  api.providersRefresh = vi.fn(async (id) => {
    const prior = catalog.providers.find((item) => item.id === id)!;
    const models = await api.providersDiscover({ ...prior, authentication: null });
    catalog = {
      providers: catalog.providers.map((item) => (item.id === id ? { ...item, models } : item)),
    };
    return catalog;
  });
  api.providersRemove = vi.fn(async (id) => {
    catalog = {
      providers: catalog.providers.filter((item) => item.id !== id),
    };
    return catalog;
  });
  const saved = vi.fn();
  component = mount(ModelSettings, { target, props: { api, saved } });
  await vi.waitFor(() => {
    flushSync();
    expect(target.textContent).not.toContain("正在加载供应商");
  });
  return { api, saved };
}
function button(label: string): HTMLButtonElement {
  const result = [...target.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === label || item.getAttribute("aria-label") === label,
  );
  if (!result) throw new Error(`缺少按钮：${label}`);
  return result;
}
function input(label: string): HTMLInputElement {
  const node = [...target.querySelectorAll("input")].find(
    (item) =>
      item.getAttribute("aria-label") === label ||
      item.closest("label")?.textContent?.trim() === label,
  );
  if (!node) throw new Error(`缺少输入：${label}`);
  return node;
}
function fill(label: string, value: string): void {
  const item = input(label);
  item.value = value;
  item.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
}
function submit(): void {
  target
    .querySelector("form")!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}
function select(label: string, value: string): void {
  const item = target.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
  if (!item) throw new Error(`缺少选择：${label}`);
  item.value = value;
  item.dispatchEvent(new Event("change", { bubbles: true }));
  flushSync();
}
async function discover(): Promise<void> {
  button("获取模型").click();
  await vi.waitFor(() => {
    flushSync();
    expect(target.textContent).not.toContain("正在获取模型");
  });
}

it("首次配置直接展示必要表单，不展示空的管理列表和默认模型卡片", async () => {
  await setup();
  expect(target.querySelector('select[aria-label="供应商预设"]')).not.toBeNull();
  expect(input("API Key")).toBeDefined();
  expect(target.querySelector('input[aria-label="搜索供应商"]')).toBeNull();
  expect(target.querySelector(".default-model")).toBeNull();
  expect(target.querySelector("aside")).toBeNull();
  expect(target.querySelectorAll("form")).toHaveLength(1);
  expect(target.textContent).not.toContain("供应商与模型");
  expect(target.querySelector('select[aria-label="模型 1"]')).toBeNull();
  expect(button("保存供应商").disabled).toBe(true);
  expect(target.textContent).not.toContain("获取模型");
});

it("只填密钥即可保存连接并自动获取全部模型，无需在配置选择模型，密钥随后清空", async () => {
  const { api, saved } = await setup();
  select("供应商预设", "gemini");
  fill("API Key", "private-key");
  submit();
  await vi.waitFor(() => {
    flushSync();
    expect(target.textContent).toContain("模型可在对话中选择");
  });
  expect(saved).toHaveBeenCalledOnce();
  expect(api.providersSave).toHaveBeenCalledWith(
    expect.objectContaining({
      protocol: "gemini",
      authentication: { type: "header", name: "x-goog-api-key", value: "private-key" },
      models: [],
    }),
  );
  expect(api.providersRefresh).toHaveBeenCalledWith("provider-0");
  expect(target.querySelector('select[aria-label="模型 1"]')).toBeNull();
  expect(api.modelSelect).not.toHaveBeenCalled();
  expect(input("API Key").value).toBe("");
  button("高级设置").click();
  flushSync();
  expect(
    target.querySelectorAll(
      'section[aria-label="模型目录"] input[placeholder="服务商提供的模型 ID"]',
    ),
  ).toHaveLength(3);
});

it("编辑留空认证只保留当前供应商，未保存切换需要明确放弃，删除有明确目标", async () => {
  const { api } = await setup({
    providers: [provider("first", "账号一"), provider("second", "账号二")],
  });
  button("高级设置").click();
  flushSync();
  fill("名称", "账号一改名");
  select("已保存供应商", "second");
  expect(target.textContent).toContain("当前修改尚未保存");
  button("继续编辑").click();
  flushSync();
  expect(input("名称").value).toBe("账号一改名");
  expect(target.querySelector<HTMLSelectElement>('select[aria-label="已保存供应商"]')!.value).toBe(
    "first",
  );
  submit();
  await vi.waitFor(() => {
    flushSync();
    expect(target.textContent).toContain("供应商已保存");
  });
  expect(api.providersSave).toHaveBeenCalledWith(
    expect.objectContaining({ id: "first", authentication: null }),
  );
  select("已保存供应商", "second");
  button("高级设置").click();
  flushSync();
  expect(input("名称").value).toBe("账号二");
  expect(api.modelSelect).not.toHaveBeenCalled();
  button("删除供应商").click();
  flushSync();
  expect(api.providersRemove).not.toHaveBeenCalled();
  button("取消").click();
  flushSync();
  expect(api.providersRemove).not.toHaveBeenCalled();
  button("删除供应商").click();
  flushSync();
  button("确认删除供应商").click();
  await vi.waitFor(() => {
    flushSync();
    expect(api.providersRemove).toHaveBeenCalledWith("second");
    expect(target.textContent).toContain("供应商已删除");
  });
});

it("保存失败保留用户填写，不显示成功状态或丢失密钥", async () => {
  const { api, saved } = await setup();
  api.providersSave = vi.fn(async () => {
    throw new Error("写盘失败");
  });
  fill("API Key", "retry-key");
  submit();
  await vi.waitFor(() => {
    flushSync();
    expect(target.textContent).toContain("写盘失败");
  });
  expect(input("API Key").value).toBe("retry-key");
  expect(saved).not.toHaveBeenCalled();
});

it("本地服务不需要密钥，自定义连接只需地址和密钥；高级输入仍可手动配置", async () => {
  const { api } = await setup();
  select("供应商预设", "ollama");
  expect(target.querySelector('input[type="password"]')).toBeNull();
  button("高级设置").click();
  flushSync();
  await discover();
  expect(api.providersDiscover).toHaveBeenLastCalledWith(
    expect.objectContaining({ authentication: { type: "none" } }),
  );
  select("供应商预设", "custom");
  fill("接口地址", "https://gateway.example/v1");
  fill("API Key", "gateway-key");
  button("手动添加模型").click();
  flushSync();
  fill("模型标识 1", "manual-model");
  submit();
  await vi.waitFor(() =>
    expect(api.providersSave).toHaveBeenCalledWith(
      expect.objectContaining({
        address: { type: "base_url", url: "https://gateway.example/v1" },
        models: [newProviderModel("manual-model")],
      }),
    ),
  );
});

it.each([null, true, false])("打开模型能力编辑不会改变已保存的图像能力：%s", async (vision) => {
  const original = provider("first", "现有连接");
  original.models[0]!.vision = vision;
  const { api } = await setup({ providers: [original] });
  button("高级设置").click();
  flushSync();
  submit();
  await vi.waitFor(() => expect(api.providersSave).toHaveBeenCalledWith(
    expect.objectContaining({ models: [{ ...newProviderModel("fixture"), vision }] }),
  ));
});

it("图像能力支持明确覆盖，也能恢复为服务商判断", async () => {
  const { api } = await setup({ providers: [provider("first", "现有连接")] });
  for (const [value, vision] of [["true", true], ["false", false], ["", null]] as const) {
    button("高级设置").click();
    flushSync();
    select("图像能力 1", value);
    submit();
    await vi.waitFor(() => {
      flushSync();
      expect(api.providersSave).toHaveBeenLastCalledWith(
        expect.objectContaining({ models: [{ ...newProviderModel("fixture"), vision }] }),
      );
      expect(target.textContent).toContain("供应商已保存");
    });
  }
});

it("连接变化使迟到发现结果失效，新连接的结果不会被旧请求覆盖", async () => {
  const { api } = await setup();
  let complete: (models: DiscoveredModel[]) => void = () => {};
  api.providersDiscover = vi
    .fn<typeof api.providersDiscover>()
    .mockImplementationOnce(
      () =>
        new Promise<DiscoveredModel[]>((resolve) => {
          complete = resolve;
        }),
    )
    .mockResolvedValueOnce([
      { ...newProviderModel("new"), name: "new", reasoning: { supported: null, efforts: null } },
    ]);
  fill("API Key", "first");
  button("高级设置").click();
  flushSync();
  button("获取模型").click();
  flushSync();
  expect(button("正在获取模型…").disabled).toBe(true);
  fill("API Key", "second");
  await discover();
  complete([
    { ...newProviderModel("old"), name: "old", reasoning: { supported: null, efforts: null } },
  ]);
  await Promise.resolve();
  flushSync();
  expect(input("模型标识 1").value).toBe("new");
  expect(target.querySelector('input[value="old"]')).toBeNull();
});

it("配置只保存接口能力，推理强度由对话选择", async () => {
  const { api } = await setup();
  api.providersDiscover = vi.fn<typeof api.providersDiscover>(async () => [
    {
      ...newProviderModel("reasoner"),
      name: "reasoner",
      reasoning: { supported: true, efforts: ["low", "max"] },
    },
  ]);
  select("供应商预设", "anthropic");
  fill("API Key", "key");
  submit();
  await vi.waitFor(() => {
    flushSync();
    expect(target.textContent).toContain("模型可在对话中选择");
  });
  expect(target.querySelector('select[aria-label="推理强度 1"]')).toBeNull();
  button("高级设置").click();
  flushSync();
  submit();
  await vi.waitFor(() => expect(api.providersSave).toHaveBeenCalledTimes(2));
  expect(vi.mocked(api.providersSave).mock.calls[1]![0].models[0]).toMatchObject({
    id: "reasoner",
    reasoning: { efforts: ["low", "max"] },
  });
  expect(vi.mocked(api.providersSave).mock.calls[1]![0].models[0]).not.toHaveProperty(
    "reasoningEffort",
  );
});

it("模型获取失败不伪报连接保存失败，保留连接并允许重试", async () => {
  const { api, saved } = await setup();
  api.providersDiscover = vi
    .fn()
    .mockRejectedValueOnce(new Error("获取模型超时"))
    .mockResolvedValueOnce([]);
  fill("API Key", "retry");
  submit();
  await vi.waitFor(() => {
    flushSync();
    expect(target.textContent).toContain("模型获取失败");
  });
  expect(target.textContent).toContain("连接已保存");
  expect(saved).toHaveBeenCalledOnce();
  expect(input("API Key").value).toBe("");
  button("高级设置").click();
  flushSync();
  await discover();
  expect(target.textContent).toContain("模型目录 · 0");
  expect(api.providersSave).toHaveBeenCalledOnce();
});
