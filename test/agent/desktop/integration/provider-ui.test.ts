/** @vitest-environment jsdom */
import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, it, vi } from "vitest";
import ModelSettings from "../../../../modules/notes/packages/desktop/src/features/agent/renderer/ModelSettings.svelte";
import {
  parseProviderUpdate,
  newProviderModel,
  type ProviderCatalog,
  type PublicProvider,
} from "../../../../modules/notes/packages/desktop/src/features/agent/shared/providers";
import { createAgentApiMock } from "../../../notes/desktop/fixtures/agent-api-mock";

let component: ModelSettings | undefined;
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
async function setup(initial: ProviderCatalog = { providers: [], active: null }) {
  target = document.createElement("div");
  document.body.append(target);
  let catalog = initial;
  const api = createAgentApiMock();
  api.providersGet = vi.fn(async () => catalog);
  api.providersSave = vi.fn(async (value) => {
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
      active:
        catalog.providers.length === 0
          ? { providerId: id, modelId: item.models[0]!.id }
          : catalog.active,
    };
    return catalog;
  });
  api.modelSelect = vi.fn(async (active) => {
    catalog = { ...catalog, active };
    return catalog;
  });
  api.providersRemove = vi.fn(async (id) => {
    catalog = {
      providers: catalog.providers.filter((item) => item.id !== id),
      active: catalog.active?.providerId === id ? null : catalog.active,
    };
    return catalog;
  });
  const saved = vi.fn();
  component = mount(ModelSettings, { target, props: { api, saved, close: vi.fn() } });
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

it("预设填充连接而不猜测模型，可保存多个模型并显示默认选择，密钥保存后清空", async () => {
  const { api, saved } = await setup();
  button("＋ 添加供应商").click();
  flushSync();
  const preset = target.querySelector<HTMLSelectElement>('select[aria-label="供应商预设"]')!;
  preset.value = "gemini";
  preset.dispatchEvent(new Event("change", { bubbles: true }));
  flushSync();
  expect(input("接口地址").value).toBe("https://generativelanguage.googleapis.com/v1beta");
  expect(input("模型标识 1").value).toBe("");
  fill("API Key", "private-key");
  fill("模型标识 1", "gemini-fixture");
  button("添加模型").click();
  flushSync();
  fill("模型标识 2", "second-model");
  submit();
  await vi.waitFor(() => {
    flushSync();
    expect(saved).toHaveBeenCalledOnce();
  });
  expect(api.providersSave).toHaveBeenCalledWith(
    expect.objectContaining({
      protocol: "gemini",
      authentication: { type: "header", name: "x-goog-api-key", value: "private-key" },
      models: expect.arrayContaining([expect.objectContaining({ id: "second-model" })]),
    }),
  );
  expect(target.textContent).toContain("Google Gemini / gemini-fixture");
  expect(input("API Key").value).toBe("");
});

it("编辑留空认证只保留当前供应商，未保存切换需要明确放弃，切换默认与删除都有目标", async () => {
  const { api } = await setup({
    providers: [provider("first", "账号一"), provider("second", "账号二")],
    active: { providerId: "first", modelId: "fixture" },
  });
  fill("名称", "账号一改名");
  target.querySelectorAll<HTMLButtonElement>(".provider-card")[1]!.click();
  flushSync();
  expect(target.textContent).toContain("当前修改尚未保存");
  button("继续编辑").click();
  flushSync();
  expect(input("名称").value).toBe("账号一改名");
  submit();
  await vi.waitFor(() => {
    flushSync();
    expect(target.textContent).toContain("供应商已保存");
  });
  expect(api.providersSave).toHaveBeenCalledWith(
    expect.objectContaining({ id: "first", authentication: null }),
  );
  target.querySelectorAll<HTMLButtonElement>(".provider-card")[0]!.click();
  flushSync();
  expect(input("名称").value).toBe("账号二");
  button("设为默认模型 fixture").click();
  await vi.waitFor(() => {
    flushSync();
    expect(target.textContent).toContain("默认模型已切换");
  });
  expect(api.modelSelect).toHaveBeenCalledWith({ providerId: "second", modelId: "fixture" });
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
    expect(target.textContent).toContain("尚未选择模型");
  });
});

it("保存失败保留用户填写，不显示成功状态或丢失密钥", async () => {
  const { api, saved } = await setup();
  api.providersSave = vi.fn(async () => {
    throw new Error("写盘失败");
  });
  button("＋ 添加供应商").click();
  flushSync();
  fill("API Key", "retry-key");
  fill("模型标识 1", "fixture");
  submit();
  await vi.waitFor(() => {
    flushSync();
    expect(target.textContent).toContain("写盘失败");
  });
  expect(input("API Key").value).toBe("retry-key");
  expect(saved).not.toHaveBeenCalled();
});
