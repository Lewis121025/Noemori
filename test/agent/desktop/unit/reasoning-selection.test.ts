import { describe, expect, it } from "vitest";
import {
  modelParameters,
  requireModelSelection,
  type StoredCatalog,
} from "../../../../modules/notes/packages/desktop/src/features/agent/main/provider-catalog";
import {
  newProviderModel,
  parseModelSelection,
  parseProviderUpdate,
  type ProviderModel,
} from "../../../../modules/notes/packages/desktop/src/features/agent/shared/providers";
import type { Protocol } from "../../../../modules/notes/packages/desktop/src/features/agent/shared/api";
import { modelReasoningEfforts } from "../../../../modules/notes/packages/desktop/src/features/agent/shared/reasoning";

it("GPT-6 Sol 只使用官网六档，网关扩展不会改写官方列表", () => {
  expect(modelReasoningEfforts(undefined, "gpt-6-sol")).toEqual([
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  expect(modelReasoningEfforts({ supported: true, efforts: ["ULTRA"] }, "gpt-6-sol")).toEqual([
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
});

it("官方模型档位不按前缀套给服务商的其他模型标识", () => {
  expect(modelReasoningEfforts(undefined, "gpt-6-sol-custom")).toEqual([]);
});

it.each([
  ["gpt-6-astra", ["low", "medium", "high", "xhigh", "max"]],
  ["gpt-6.1-sol", ["low", "medium", "high", "xhigh", "max"]],
  ["gpt-5.5", ["none", "low", "medium", "high", "xhigh"]],
  ["gpt-5.5-2026-04-23", ["none", "low", "medium", "high", "xhigh"]],
  ["gpt-5.5-pro", ["medium", "high", "xhigh"]],
  ["gemini-3.1-pro-preview", ["low", "medium", "high"]],
  ["gemini-3-pro-preview", ["low", "high"]],
  ["gemini-3-flash-preview", ["minimal", "low", "medium", "high"]],
] as const)("%s 按该模型官方定义列出全部档位", (modelId, efforts) => {
  expect(modelReasoningEfforts(undefined, modelId)).toEqual(efforts);
});

it("未知模型只采用接口明确报告的列表，不补入其他模型的档位", () => {
  expect(modelReasoningEfforts({ supported: true, efforts: ["low", "ULTRA"] }, "private-model")).toEqual(["low", "ULTRA"]);
  expect(modelReasoningEfforts({ supported: true, efforts: [] }, "private-model")).toEqual([]);
  expect(modelReasoningEfforts({ supported: null, efforts: null }, "private-model")).toEqual([]);
});

function catalog(
  protocol: Protocol,
  model: ProviderModel = newProviderModel("custom-model"),
): StoredCatalog {
  return {
    active: null,
    providers: [
      {
        encrypted: null,
        provider: {
          id: "provider",
          name: "测试连接",
          protocol,
          address: { type: "endpoint", url: "https://example.com/v1/model" },
          authentication: { type: "none", configured: false, name: "", region: "" },
          models: [model],
        },
      },
    ],
  };
}

describe.each([
  "openai-chat",
  "openai-responses",
  "anthropic",
  "vertex-anthropic",
  "gemini",
  "ollama",
  "bedrock",
] as const)("%s 的对话推理强度", (protocol) => {
  it.each(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ULTRA"])(
    "接口未报告能力时允许手动选择 %s，原生配置保留原值",
    (reasoningEffort) => {
      const selection = parseModelSelection({
        providerId: "provider",
        modelId: "custom-model",
        reasoningEffort,
      });
      const chosen = requireModelSelection(catalog(protocol), selection);
      expect(modelParameters(chosen)).toMatchObject({ protocol, reasoningEffort });
      expect(modelParameters(chosen)).not.toHaveProperty("reasoning");
    },
  );

  it("服务商默认省略参数，能力元数据不拦截显式选择", () => {
    const selection = { providerId: "provider", modelId: "custom-model" };
    expect(modelParameters(requireModelSelection(catalog(protocol), selection))).not.toHaveProperty(
      "reasoningEffort",
    );
    for (const reasoning of [
      { supported: false, efforts: null },
      { supported: true, efforts: [] },
      { supported: true, efforts: ["low"] as const },
    ]) {
      const model = {
        ...newProviderModel("custom-model"),
        reasoning: {
          ...reasoning,
          efforts: reasoning.efforts === null ? null : [...reasoning.efforts],
        },
      };
      expect(
        modelParameters(
          requireModelSelection(catalog(protocol, model), {
            ...selection,
            reasoningEffort: "max",
          }),
        ),
      ).toMatchObject({ protocol, reasoningEffort: "max" });
      const stored = catalog(protocol, model).providers[0]!.provider;
      const parsed = parseProviderUpdate({
        ...stored,
        authentication: { type: "none" },
        models: [{ ...model, reasoningEffort: "max" }],
      });
      expect(parsed.models[0]?.reasoningEffort).toBe("max");
    }
  });

  it("持久化连接校验与对话校验使用相同规则，不把显式 none 当作默认", () => {
    const stored = catalog(protocol).providers[0]!.provider;
    const parsed = parseProviderUpdate({
      ...stored,
      authentication: { type: "none" },
      models: [{ ...stored.models[0], reasoningEffort: "none" }],
    });
    expect(parsed.models[0]?.reasoningEffort).toBe("none");
  });
});
