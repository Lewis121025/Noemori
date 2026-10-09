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

it("视觉能力未知时由服务商判断图片请求，明确不支持时保持关闭", () => {
  const model = newProviderModel("接口没有报告能力");
  expect(model.vision).toBeNull();
  const selection = { providerId: "provider", modelId: model.id };
  expect(modelParameters(requireModelSelection(catalog("openai-chat", model), selection)).vision).toBe(true);
  model.vision = false;
  expect(modelParameters(requireModelSelection(catalog("openai-chat", model), selection)).vision).toBe(false);
});

it.each(["gpt-6-sol", "openai/gpt-6.1-sol", "claude-opus-4-6", "google/gemini-3-flash-preview"])(
  "%s 的档位必须以当前接口为准，缺失能力时不按模型名补齐",
  (modelId) => {
    const model = newProviderModel(modelId);
    expect(modelReasoningEfforts(model.reasoning)).toEqual([]);
    model.reasoning = { supported: true, efforts: ["ULTRA"] };
    expect(modelReasoningEfforts(model.reasoning)).toEqual(["ULTRA"]);
    model.reasoning = { supported: true, efforts: [] };
    expect(modelReasoningEfforts(model.reasoning)).toEqual([]);
  },
);

it.each([
  "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-opus-4-6-v1",
  "arn:aws:bedrock:us-east-1:123456789012:inference-profile/global.anthropic.claude-opus-4-6-v1",
  "arn:aws:bedrock:ap-northeast-1:123456789012:inference-profile/jp.anthropic.claude-sonnet-4-6",
  "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.amazon.nova-2-lite-v1:0",
])("Bedrock 资源 %s 发送时保留原始模型标识", (modelId) => {
  const selection = { providerId: "provider", modelId, reasoningEffort: "high" };
  const selected = requireModelSelection(catalog("bedrock", newProviderModel(modelId)), selection);
  expect(modelParameters(selected)).toMatchObject({ model: modelId, reasoningEffort: "high" });
});

it("采用接口明确报告的原名，能力缺失或列表为空时不生成候选", () => {
  expect(modelReasoningEfforts({ supported: true, efforts: ["low", "ULTRA"] })).toEqual([
    "low",
    "ULTRA",
  ]);
  expect(modelReasoningEfforts()).toEqual([]);
  expect(modelReasoningEfforts({ supported: true, efforts: [] })).toEqual([]);
  expect(modelReasoningEfforts({ supported: true, efforts: null })).toEqual([]);
  expect(modelReasoningEfforts({ supported: null, efforts: null })).toEqual([]);
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
