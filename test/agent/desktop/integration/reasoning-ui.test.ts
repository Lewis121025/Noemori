/** @vitest-environment jsdom */
import { flushSync, mount, unmount } from "svelte";
import { expect, it, onTestFinished, vi } from "vitest";
import ConversationModel from "../../../../modules/notes/packages/desktop/src/features/agent/renderer/ConversationModel.svelte";
import { newProviderModel } from "../../../../modules/notes/packages/desktop/src/features/agent/shared/providers";
import { createAgentApiMock } from "../../../notes/desktop/fixtures/agent-api-mock";

it.each([
  { saved: "high", displayed: "high" },
  { saved: undefined, displayed: "medium" },
])(
  "官方模型缺少接口元数据时显示官方档位与实际强度 $displayed，没有默认占位",
  async ({ saved, displayed }) => {
    const target = document.createElement("div");
    document.body.append(target);
    const originalPopover = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "showPopover");
    Object.defineProperty(HTMLElement.prototype, "showPopover", { configurable: true, value() {} });
    const api = createAgentApiMock();
    api.providersGet = vi.fn<typeof api.providersGet>(async () => ({
      providers: [
        {
          id: "provider",
          name: "同名模型的网关",
          protocol: "openai-responses",
          address: { type: "base_url", url: "https://example.com/v1" },
          authentication: { type: "none", configured: false, name: "", region: "" },
          models: [newProviderModel("gpt-6-sol")],
        },
      ],
    }));
    api.modelSelect = vi.fn<typeof api.modelSelect>(async (_id, value) => value);
    const changed = vi.fn();
    const component = mount(ConversationModel, {
      target,
      props: {
        api,
        conversationId: "conversation",
        selection: {
          providerId: "provider",
          modelId: "gpt-6-sol",
          ...(saved === undefined ? {} : { reasoningEffort: saved }),
        },
        running: false,
        changed,
        configure: () => {},
      },
    });
    onTestFinished(async () => {
      await unmount(component);
      target.remove();
      if (originalPopover)
        Object.defineProperty(HTMLElement.prototype, "showPopover", originalPopover);
      else Reflect.deleteProperty(HTMLElement.prototype, "showPopover");
    });
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector('button[aria-label="选择推理强度"]')).not.toBeNull();
    });
    target.querySelector<HTMLButtonElement>('button[aria-label="选择推理强度"]')!.click();
    flushSync();
    const options = [...target.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
    expect(options.map((option) => option.textContent?.trim())).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(
      options.find((option) => option.getAttribute("aria-checked") === "true")?.textContent?.trim(),
    ).toBe(displayed);
    expect(target.textContent).not.toContain("服务商默认");
    expect(target.textContent).not.toContain("服务商未提供可选推理档位");
    options[1]!.click();
    await vi.waitFor(() =>
      expect(changed).toHaveBeenCalledWith({
        providerId: "provider",
        modelId: "gpt-6-sol",
        reasoningEffort: "low",
      }),
    );
    expect(api.modelSelect).toHaveBeenCalledWith("conversation", {
      providerId: "provider",
      modelId: "gpt-6-sol",
      reasoningEffort: "low",
    });
  },
);

it.each([
  { protocol: "openai-chat", reasoning: { supported: false, efforts: null } },
  { protocol: "openai-responses", reasoning: { supported: true, efforts: ["low"] } },
  { protocol: "anthropic", reasoning: { supported: true, efforts: [] } },
  { protocol: "vertex-anthropic", reasoning: { supported: null, efforts: null } },
  { protocol: "gemini", reasoning: { supported: false, efforts: [] } },
  { protocol: "ollama", reasoning: { supported: true, efforts: ["low", "high", "ULTRA"] } },
  { protocol: "bedrock", reasoning: { supported: null, efforts: null } },
] as const)(
  "$protocol 只显示模型报告的原始档位，未知或空列表不生成候选",
  async ({ protocol, reasoning }) => {
    const target = document.createElement("div");
    document.body.append(target);
    const originalPopover = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "showPopover");
    Object.defineProperty(HTMLElement.prototype, "showPopover", { configurable: true, value() {} });
    const api = createAgentApiMock();
    api.providersGet = vi.fn<typeof api.providersGet>(async () => ({
      providers: [
        {
          id: "provider",
          name: "自定义连接",
          protocol,
          address: { type: "base_url", url: "https://example.com/v1" },
          authentication: { type: "none", configured: false, name: "", region: "" },
          models: [
            {
              ...newProviderModel("custom-model"),
              reasoning: {
                ...reasoning,
                efforts: reasoning.efforts === null ? null : [...reasoning.efforts],
              },
            },
          ],
        },
      ],
    }));
    api.modelSelect = vi.fn<typeof api.modelSelect>(async (_id, value) => value);
    const changed = vi.fn();
    const component = mount(ConversationModel, {
      target,
      props: {
        api,
        conversationId: "conversation",
        selection: { providerId: "provider", modelId: "custom-model" },
        running: true,
        changed,
        configure: () => {},
      },
    });
    onTestFinished(async () => {
      await unmount(component);
      target.remove();
      if (originalPopover)
        Object.defineProperty(HTMLElement.prototype, "showPopover", originalPopover);
      else Reflect.deleteProperty(HTMLElement.prototype, "showPopover");
    });
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector('button[aria-label="选择对话模型"]')?.textContent).toContain(
        "custom-model",
      );
    });
    if (!reasoning.efforts?.length) {
      expect(target.querySelector('button[aria-label="选择推理强度"]')).toBeNull();
      expect(target.textContent).not.toContain("服务商默认");
      expect(api.modelSelect).not.toHaveBeenCalled();
      return;
    }
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector('button[aria-label="选择推理强度"]')).not.toBeNull();
    });
    target.querySelector<HTMLButtonElement>('button[aria-label="选择推理强度"]')!.click();
    flushSync();
    const options = [...target.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
    expect(options.filter((option) => option.getAttribute("aria-checked") === "true")).toEqual([]);
    expect(options.map((option) => option.textContent?.trim())).toEqual([
      ...(reasoning.efforts ?? []),
    ]);
    expect(target.textContent).toContain("切换从下一轮生效");
    const selectedEffort = reasoning.efforts?.at(-1);
    options.find((option) => option.textContent?.trim() === selectedEffort)!.click();
    await vi.waitFor(() =>
      expect(changed).toHaveBeenCalledWith({
        providerId: "provider",
        modelId: "custom-model",
        reasoningEffort: selectedEffort,
      }),
    );
    expect(api.modelSelect).toHaveBeenCalledWith("conversation", {
      providerId: "provider",
      modelId: "custom-model",
      reasoningEffort: selectedEffort,
    });
  },
);
