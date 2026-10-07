import { expect, it } from "vitest";
import {
  parseProviderUpdate,
  providerEndpoint,
} from "../../../../modules/notes/packages/desktop/src/features/agent/shared/providers";

it.each([
  ["openai-responses", "https://example.com/v1/", "https://example.com/v1/responses"],
  [
    "openai-chat",
    "https://example.com/gateway/v1",
    "https://example.com/gateway/v1/chat/completions",
  ],
  ["anthropic", "https://example.com/v1", "https://example.com/v1/messages"],
  [
    "gemini",
    "https://example.com/v1beta",
    "https://example.com/v1beta/models/model%2Fname:generateContent",
  ],
  ["ollama", "http://localhost:11434/api", "http://localhost:11434/api/chat"],
] as const)("%s 从明确的 Base URL 构造请求路径", (protocol, url, expected) => {
  expect(providerEndpoint(protocol, { type: "base_url", url }, "model/name")).toBe(expected);
});

it("完整 URL 保留部署路径和查询参数，拒绝片段与内嵌凭据", () => {
  const url = "https://example.com/deployments/test/chat?api-version=2025-01-01";
  expect(providerEndpoint("openai-chat", { type: "endpoint", url }, "model")).toBe(url);
  for (const invalid of [
    "https://user:secret@example.com/v1",
    "https://example.com/v1#fragment",
    "file:///v1",
  ]) {
    expect(() =>
      providerEndpoint("openai-chat", { type: "base_url", url: invalid }, "model"),
    ).toThrow();
  }
  expect(() =>
    providerEndpoint("bedrock", { type: "base_url", url: "https://example.com" }, "model"),
  ).toThrow("完整");
  expect(
    providerEndpoint(
      "bedrock",
      { type: "endpoint", url: "https://example.com/model/{model}/converse" },
      "name/version",
    ),
  ).toBe("https://example.com/model/name%2Fversion/converse");
});

const model = {
  id: "fixture",
  tools: true,
  streaming: true,
  vision: false,
  audio: false,
  video: false,
};
const provider = {
  id: null,
  name: "供应商",
  protocol: "openai-chat",
  address: { type: "base_url", url: "https://example.com/v1" },
  authentication: { type: "none" },
  models: [model],
};

it("供应商输入拒绝空模型、重复模型、空凭据和不存在的保留目标", () => {
  expect(parseProviderUpdate(provider)).toEqual(provider);
  for (const models of [[], [model, model], [{ ...model, id: " " }]]) {
    expect(() => parseProviderUpdate({ ...provider, models })).toThrow("模型");
  }
  expect(() => parseProviderUpdate({ ...provider, authentication: null })).toThrow("认证");
  expect(() =>
    parseProviderUpdate({ ...provider, authentication: { type: "bearer", value: "" } }),
  ).toThrow("认证");
});

it("认证请求头有明确上限，模型标识必须能无损传给原生 UTF-8 JSON", () => {
  expect(() =>
    parseProviderUpdate({
      ...provider,
      authentication: { type: "header", name: "x".repeat(8193), value: "key" },
    }),
  ).toThrow("认证");
  expect(() =>
    parseProviderUpdate({ ...provider, models: [{ ...model, id: "broken\ud800" }] }),
  ).toThrow("模型");
});
