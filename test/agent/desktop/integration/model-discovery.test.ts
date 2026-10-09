import { afterEach, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { discoverModels } from "../../../../modules/notes/packages/desktop/src/features/agent/main/model-discovery";
import type { ProviderConnection } from "../../../../modules/notes/packages/desktop/src/features/agent/shared/providers";

const connection: ProviderConnection = {
  id: null,
  protocol: "openai-chat",
  address: { type: "base_url", url: "https://example.com/gateway/v1/?version=1" },
  authentication: { type: "bearer", value: "private-key" },
};
afterEach(() => vi.unstubAllGlobals());

it("真实 HTTP 获取列表，拒绝跟随重定向，密钥不交给重定向目标", async (test) => {
  const requests: string[] = [];
  const server = createServer((input, output) => {
    requests.push(input.url ?? "");
    if (input.url === "/redirect/models") {
      output.writeHead(302, { location: "/destination" });
      output.end();
      return;
    }
    expect(input.headers.authorization).toBe("Bearer private-key");
    output.writeHead(200, { "content-type": "application/json" });
    output.end(JSON.stringify({ data: [{ id: "real-model" }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  test.onTestFinished(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture 未监听");
  const base = `http://127.0.0.1:${address.port}`;
  const discovered = await discoverModels({
    ...connection,
    address: { type: "base_url", url: `${base}/v1` },
  });
  expect(discovered[0]?.id).toBe("real-model");
  expect(discovered[0]?.vision).toBeNull();
  await expect(
    discoverModels({ ...connection, address: { type: "base_url", url: `${base}/redirect` } }),
  ).rejects.toThrow("无法连接");
  expect(requests).toEqual(["/v1/models", "/redirect/models"]);
});

it("使用原连接的路径、查询和认证获取模型，不根据模型名猜测推理档位", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({ data: [{ id: "o3" }, { id: "custom" }] }),
  );
  vi.stubGlobal("fetch", fetch);
  const models = await discoverModels(connection);
  expect(fetch).toHaveBeenCalledOnce();
  const [url, options] = fetch.mock.calls[0]!;
  expect(String(url)).toBe("https://example.com/gateway/v1/models?version=1");
  expect(new Headers(options?.headers).get("authorization")).toBe("Bearer private-key");
  expect(options?.redirect).toBe("error");
  expect(models.map((model) => [model.id, model.reasoning])).toEqual([
    ["o3", { supported: null, efforts: null }],
    ["custom", { supported: null, efforts: null }],
  ]);
});

it("兼容服务的参数列表只能确认支持，不能从缺少参数推断模型不支持推理", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        data: [
          { id: "thinking", supported_parameters: ["reasoning"] },
          { id: "unknown", supported_parameters: ["temperature"] },
        ],
      }),
    ),
  );
  const models = await discoverModels(connection);
  expect(models[0]?.reasoning).toEqual({ supported: true, efforts: null });
  expect(models[1]?.reasoning).toEqual({ supported: null, efforts: null });
});

it("Ollama 保留接口报告的全部推理名称和布尔开关，不依赖 capabilities 字段", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json({ models: [{ name: "local:latest" }] }))
    .mockResolvedValueOnce(
      Response.json({ thinking: { values: [false, true, "low", "ULTRA"], default: "low" } }),
    );
  vi.stubGlobal("fetch", fetch);
  const models = await discoverModels({
    ...connection,
    protocol: "ollama",
    authentication: { type: "none" },
  });
  expect(models[0]?.reasoning).toEqual({
    supported: true,
    efforts: ["false", "true", "low", "ULTRA"],
  });
});

it("Anthropic 遍历分页，只提供接口明确支持的推理档位", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      Response.json({
        data: [
          {
            id: "first",
            display_name: "第一个",
            capabilities: {
              thinking: { supported: true },
              effort: {
                supported: true,
                low: { supported: true },
                high: { supported: false },
                max: { supported: true },
              },
              image_input: { supported: true },
            },
          },
        ],
        has_more: true,
        last_id: "first",
      }),
    )
    .mockResolvedValueOnce(
      Response.json({ data: [{ id: "second", capabilities: null }], has_more: false }),
    );
  vi.stubGlobal("fetch", fetch);
  const models = await discoverModels({
    ...connection,
    protocol: "anthropic",
    authentication: { type: "header", name: "x-api-key", value: "secret" },
  });
  expect(models[0]).toMatchObject({
    id: "first",
    name: "第一个",
    vision: true,
    reasoning: { supported: true, efforts: ["low", "max"] },
  });
  expect(models[1]?.reasoning).toEqual({ supported: null, efforts: null });
  expect(new URL(String(fetch.mock.calls[1]![0])).searchParams.get("after_id")).toBe("first");
  const headers = new Headers(fetch.mock.calls[0]![1]?.headers);
  expect(headers.get("x-api-key")).toBe("secret");
  expect(headers.get("anthropic-version")).toBe("2023-06-01");
});

it("Gemini 只列出支持生成内容的模型，保留精确版本 ID 并处理分页", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      Response.json({
        models: [
          {
            name: "models/gemini-test-001",
            displayName: "测试模型",
            supportedGenerationMethods: ["generateContent"],
            thinking: true,
          },
          { name: "models/embedding", supportedGenerationMethods: ["embedContent"] },
        ],
        nextPageToken: "next",
      }),
    )
    .mockResolvedValueOnce(Response.json({ models: [] }));
  vi.stubGlobal("fetch", fetch);
  const models = await discoverModels({ ...connection, protocol: "gemini" });
  expect(models).toHaveLength(1);
  expect(models[0]).toMatchObject({
    id: "gemini-test-001",
    reasoning: { supported: true, efforts: null },
  });
  expect(new URL(String(fetch.mock.calls[1]![0])).searchParams.get("pageToken")).toBe("next");
});

it("Ollama 使用 tags 和 show 获取模型与真实能力，缺失档位保留默认", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json({ models: [{ name: "local:latest" }] }))
    .mockResolvedValueOnce(
      Response.json({ capabilities: ["completion", "tools", "thinking", "vision"] }),
    );
  vi.stubGlobal("fetch", fetch);
  const models = await discoverModels({
    ...connection,
    protocol: "ollama",
    authentication: { type: "none" },
  });
  expect(String(fetch.mock.calls[0]![0])).toContain("/tags?");
  expect(String(fetch.mock.calls[1]![0])).toContain("/show?");
  expect(JSON.parse(String(fetch.mock.calls[1]![1]?.body))).toEqual({ model: "local:latest" });
  expect(models[0]).toMatchObject({
    tools: true,
    vision: true,
    reasoning: { supported: true, efforts: null },
  });
});

it.each([401, 403, 404, 429, 500])(
  "HTTP %s 仅报告状态和操作建议，不泄漏响应中的凭据",
  async (status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("private-key", { status })),
    );
    await expect(discoverModels(connection)).rejects.toThrow(String(status));
    await expect(discoverModels(connection)).rejects.not.toThrow("private-key");
  },
);

it.each([{ data: [{ id: "" }] }, { data: [{ id: "broken\ud800" }] }, { data: "bad" }])(
  "拒绝无效模型目录，不返回看似成功的空结果",
  async (body) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(body)),
    );
    await expect(discoverModels(connection)).rejects.toThrow("模型列表格式无效");
  },
);

it("重复分页游标、超限响应和请求错误都明确失败", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ data: [{ id: "same" }], has_more: true, last_id: "same" })),
  );
  await expect(discoverModels({ ...connection, protocol: "anthropic" })).rejects.toThrow("分页");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("x".repeat(4 * 1024 * 1024 + 1))),
  );
  await expect(discoverModels(connection)).rejects.toThrow("过大");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("private-key");
    }),
  );
  await expect(discoverModels(connection)).rejects.toThrow("无法连接模型服务");
});

it("不从完整部署地址或云签名协议猜测模型列表 URL", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(
    discoverModels({
      ...connection,
      address: { type: "endpoint", url: "https://example.com/deployment" },
    }),
  ).rejects.toThrow("Base URL");
  expect(fetch).not.toHaveBeenCalled();
});

it("非法 UTF-8 和不能传给请求头的认证明确拒绝，错误不包含凭据", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(new Uint8Array([0xff])));
  vi.stubGlobal("fetch", fetch);
  await expect(discoverModels(connection)).rejects.toThrow("模型列表格式无效");
  const result = discoverModels({
    ...connection,
    authentication: { type: "bearer", value: "私密密钥" },
  });
  await expect(result).rejects.toThrow("认证无法");
  await expect(result).rejects.not.toThrow("私密密钥");
  expect(fetch).toHaveBeenCalledOnce();
});
