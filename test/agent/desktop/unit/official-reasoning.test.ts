import { expect, it } from "vitest";
import {
  modelReasoningEfforts,
  parseReasoningCapability,
  resolveReasoningEffort,
} from "../../../../modules/notes/packages/desktop/src/features/agent/shared/reasoning";
import { modelParameters } from "../../../../modules/notes/packages/desktop/src/features/agent/main/provider-catalog";
import { newProviderModel } from "../../../../modules/notes/packages/desktop/src/features/agent/shared/providers";
import type { Protocol } from "../../../../modules/notes/packages/desktop/src/features/agent/shared/api";

it.each([
  ["openai-responses", "gpt-6-astra", ["low", "medium", "high", "xhigh", "max"]],
  ["openai-chat", "openai/gpt-6.1-sol", ["low", "medium", "high", "xhigh", "max"]],
  ["openai-responses", "gpt-6-sol", ["none", "low", "medium", "high", "xhigh", "max"]],
  ["openai-responses", "gpt-6-luna", ["none", "low", "medium", "high", "xhigh", "max"]],
  ["openai-chat", "gpt-5.6-sol", ["none", "low", "medium", "high", "xhigh", "max"]],
  ["openai-chat", "gpt-5.6-terra", ["none", "low", "medium", "high", "xhigh", "max"]],
  ["openai-chat", "gpt-5.6-luna", ["none", "low", "medium", "high", "xhigh", "max"]],
  ["openai-chat", "gpt-5.5", ["none", "low", "medium", "high", "xhigh"]],
  ["openai-responses", "gpt-5.4-2026-03-05", ["none", "low", "medium", "high", "xhigh"]],
  ["openai-responses", "gpt-5.4-pro", ["medium", "high", "xhigh"]],
  ["openai-chat", "gpt-5.1", ["none", "low", "medium", "high"]],
  ["openai-chat", "gpt-5", ["minimal", "low", "medium", "high"]],
  ["openai-responses", "gpt-5.3-codex", ["low", "medium", "high", "xhigh"]],
  ["anthropic", "claude-opus-4-5-20251101", ["low", "medium", "high"]],
  ["anthropic", "claude-opus-4-6", ["low", "medium", "high", "max"]],
  ["anthropic", "claude-sonnet-4-6", ["low", "medium", "high", "max"]],
  ["vertex-anthropic", "claude-opus-4-7", ["low", "medium", "high", "xhigh", "max"]],
  ["anthropic", "claude-opus-5-5", ["low", "medium", "high", "xhigh", "max"]],
  ["anthropic", "claude-haiku-5-5", ["low", "medium", "high", "xhigh", "max"]],
  ["anthropic", "claude-mythos-preview", ["low", "medium", "high", "max"]],
  ["openai-chat", "anthropic/claude-opus-4.6", ["low", "medium", "high", "max"]],
  [
    "bedrock",
    "arn:aws:bedrock:us-east-1:123456789012:inference-profile/global.anthropic.claude-opus-4-6-v1",
    ["low", "medium", "high", "max"],
  ],
  ["bedrock", "us.amazon.nova-2-lite-v1:0", ["low", "medium", "high"]],
  ["gemini", "models/gemini-3.1-pro-preview", ["low", "medium", "high"]],
  ["gemini", "gemini-3-flash-preview", ["minimal", "low", "medium", "high"]],
  ["gemini", "gemini-3.1-flash-lite", ["minimal", "low", "medium", "high"]],
  ["gemini", "gemini-3.1-flash-lite-image", ["minimal", "high"]],
  ["gemini", "gemini-3.8-flash", ["low", "medium", "high"]],
  ["gemini", "gemini-3.6-flash", ["minimal", "low", "medium", "high"]],
  ["ollama", "gpt-oss:120b", ["low", "medium", "high"]],
] satisfies [Protocol, string, string[]][])(
  "%s / %s 缺少能力元数据时仍提供官方原名档位",
  (protocol, modelId, efforts) => {
    expect(modelReasoningEfforts(undefined, modelId, protocol)).toEqual(efforts);
    expect(modelReasoningEfforts({ supported: null, efforts: null }, modelId, protocol)).toEqual(
      efforts,
    );
  },
);

it("已知模型的官方契约不被空列表或虚构档位覆盖", () => {
  for (const efforts of [[], ["ULTRA", "none"]]) {
    expect(
      modelReasoningEfforts({ supported: true, efforts }, "gpt-6-astra", "openai-responses"),
    ).toEqual(["low", "medium", "high", "xhigh", "max"]);
  }
});

it.each([
  ["gemini", "gemini-2.5-pro"],
  ["anthropic", "claude-haiku-4-5"],
  ["openai-chat", "gpt-4.1"],
  ["openai-responses", "gpt-6-future"],
  ["gemini", "gpt-6-sol"],
] satisfies [Protocol, string][])("%s / %s 不编造官方未定义的强度档位", (protocol, modelId) => {
  expect(modelReasoningEfforts(undefined, modelId, protocol)).toEqual([]);
});

it.each([
  ["openai-responses", "gpt-6-sol", "medium"],
  ["openai-responses", "gpt-6.1-sol", "medium"],
  ["openai-responses", "gpt-5.5-pro", "high"],
  ["openai-responses", "gpt-5.4", "none"],
  ["anthropic", "claude-opus-5-5", "medium"],
  ["anthropic", "claude-opus-4-7", "high"],
  ["gemini", "gemini-3.1-flash-lite", "minimal"],
  ["gemini", "gemini-3.8-flash", "medium"],
] satisfies [Protocol, string, string][])(
  "%s / %s 未保存强度时菜单与实际请求都采用官方具体值 %s",
  (protocol, modelId, effort) => {
    expect(resolveReasoningEffort(modelId, protocol)).toBe(effort);
    const parameters = modelParameters({
      record: {
        encrypted: null,
        provider: {
          id: "provider",
          name: "模型连接",
          protocol,
          address: { type: "base_url", url: "https://example.com/v1" },
          authentication: { type: "none", configured: false, name: "", region: "" },
          models: [newProviderModel(modelId)],
        },
      },
      model: newProviderModel(modelId),
      selection: { providerId: "provider", modelId },
    });
    expect(parameters.reasoningEffort).toBe(effort);
    expect(resolveReasoningEffort(modelId, protocol, "high")).toBe("high");
  },
);

it("已知型号拒绝非法旧档位，避免再次把不支持的参数发给模型服务", () => {
  expect(() => resolveReasoningEffort("gpt-6-astra", "openai-responses", "none")).toThrow(
    "不支持推理强度 none",
  );
  expect(() => resolveReasoningEffort("claude-opus-4-6", "anthropic", "xhigh")).toThrow(
    "不支持推理强度 xhigh",
  );
});

it("官方没有公布初始档位时不采用外部元数据中的虚构初始值", () => {
  expect(
    resolveReasoningEffort("gpt-6-astra", "openai-responses", undefined, {
      supported: true,
      efforts: ["none"],
      defaultEffort: "none",
    }),
  ).toBeUndefined();
});

it("Ollama 以实际模型报告的原名和初始值为准，并校验持久化契约", () => {
  const capability = parseReasoningCapability({
    supported: true,
    efforts: ["false", "low", "xhigh"],
    defaultEffort: "xhigh",
  });
  expect(modelReasoningEfforts(capability, "gpt-oss:custom", "ollama")).toEqual([
    "false",
    "low",
    "xhigh",
  ]);
  expect(resolveReasoningEffort("gpt-oss:custom", "ollama", undefined, capability)).toBe("xhigh");
  expect(() => parseReasoningCapability({ ...capability, defaultEffort: "high" })).toThrow(
    "不属于可选档位",
  );
});
