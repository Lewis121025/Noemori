import type { Protocol } from "../shared/api";
import {
  newProviderModel,
  parseProviderConnection,
  providerModelLimit,
  type DiscoveredModel,
  type ProviderConnection,
} from "../shared/providers";
import { record } from "../shared/parse";
import { parseReasoningEffort, type ReasoningCapability } from "../shared/reasoning";

const maxBytes = 4 * 1024 * 1024;
const maxModels = providerModelLimit;

/**
 * 只请求用户配置的连接，认证由主进程提供；重定向不得转交密钥。
 * @param connection 已有认证材料的连接，不需要预先知道模型 ID。
 * @returns 去重后的模型及接口明确报告的能力，不猜测未知推理档位。
 * @throws 连接不支持发现、认证、超时、HTTP、格式或目录预算失败时拒绝。
 */
export async function discoverModels(connection: ProviderConnection): Promise<DiscoveredModel[]> {
  const input = parseProviderConnection(connection);
  if (
    input.address.type !== "base_url" ||
    input.protocol === "bedrock" ||
    input.protocol === "vertex-anthropic"
  )
    throw new Error("自动获取模型需要支持模型列表的 Base URL；此部署可在高级设置中手动添加模型");
  if (input.authentication === null) throw new Error("模型发现缺少认证材料");
  const headers = new Headers({ accept: "application/json" });
  const auth = input.authentication;
  if (auth.type === "aws") throw new Error("此认证方式不支持自动获取模型");
  if (input.protocol === "anthropic") headers.set("anthropic-version", "2023-06-01");
  try {
    if (auth.type === "bearer") headers.set("authorization", `Bearer ${auth.value}`);
    if (auth.type === "header") headers.set(auth.name, auth.value);
  } catch {
    throw new Error("模型认证无法作为 HTTP 请求头发送");
  }
  const base = new URL(input.address.url);
  const url = new URL(base);
  url.pathname = `${base.pathname.replace(/\/+$/u, "")}/${input.protocol === "ollama" ? "tags" : "models"}`;
  const request = discoveryRequest(headers);
  const models = new Map<string, DiscoveredModel>();
  const cursors = new Set<string>();
  for (let page = 0; page < 32; page += 1) {
    const raw = await request(new URL(url));
    const result = parsePage(input.protocol, raw);
    for (const model of result.models) models.set(model.id, model);
    if (models.size > maxModels) throw new Error("模型列表超过数量限制");
    if (!result.cursor) {
      if (input.protocol === "ollama")
        await ollamaCapabilities([...models.values()], base, request);
      return [...models.values()];
    }
    if (cursors.has(result.cursor)) throw new Error("模型列表分页游标重复");
    cursors.add(result.cursor);
    url.searchParams.set(input.protocol === "gemini" ? "pageToken" : "after_id", result.cursor);
  }
  throw new Error("模型列表分页超过限制");
}

/** 分页和模型详情共享同一预算，防止逐请求重置上限。 */
type DiscoveryBudget = { signal: AbortSignal; remainingBytes: number };

function discoveryRequest(
  headers: Headers,
): (target: URL, body?: object) => Promise<Record<string, unknown>> {
  const budget: DiscoveryBudget = { signal: AbortSignal.timeout(15000), remainingBytes: maxBytes };
  return async (target, body) => {
    let response: Response;
    try {
      response = await fetch(target, {
        method: body ? "POST" : "GET",
        headers: body ? new Headers([...headers, ["content-type", "application/json"]]) : headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: budget.signal,
        redirect: "error",
      });
    } catch {
      throw new Error(
        budget.signal.aborted ? "获取模型超时，请重试" : "无法连接模型服务，请检查接口地址和网络",
      );
    }
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        throw new Error(`获取模型失败（HTTP ${response.status}），响应无法取消`);
      }
      throw new Error(`获取模型失败（HTTP ${response.status}），${httpHint(response.status)}`);
    }
    return readModelJson(response, budget);
  };
}

function httpHint(status: number): string {
  if (status === 401 || status === 403) return "请检查 API Key 和账号权限";
  if (status === 404) return "服务未提供模型列表，请检查 Base URL 或在高级设置中手动添加";
  if (status === 429) return "请求过于频繁，请稍后重试";
  return "请稍后重试";
}

async function readModelJson(
  response: Response,
  budget: DiscoveryBudget,
): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("模型列表格式无效");
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      budget.remainingBytes -= value.byteLength;
      if (budget.remainingBytes < 0) throw new Error("模型列表响应过大");
      chunks.push(value);
    }
  } catch {
    const message =
      budget.remainingBytes < 0
        ? "模型列表响应过大"
        : budget.signal.aborted
          ? "获取模型超时，请重试"
          : "模型列表读取失败，请重试";
    try {
      await reader.cancel();
    } catch {
      throw new Error(`${message}，响应无法取消`);
    }
    throw new Error(message);
  } finally {
    reader.releaseLock();
  }
  try {
    return record(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))),
    );
  } catch {
    throw new Error("模型列表格式无效");
  }
}

function parsePage(
  protocol: Protocol,
  raw: Record<string, unknown>,
): { models: DiscoveredModel[]; cursor: string | null } {
  try {
    const items = raw[protocol === "gemini" || protocol === "ollama" ? "models" : "data"];
    if (!Array.isArray(items) || items.length > maxModels) throw new Error();
    const models: DiscoveredModel[] = [];
    for (const value of items) {
      const item = record(value);
      if (protocol === "gemini") {
        const methods = item["supportedGenerationMethods"];
        if (!Array.isArray(methods) || !methods.every((method) => typeof method === "string"))
          throw new Error();
        if (!methods.includes("generateContent")) continue;
      }
      const rawId = item[protocol === "gemini" || protocol === "ollama" ? "name" : "id"];
      if (typeof rawId !== "string") throw new Error();
      const id = protocol === "gemini" ? rawId.replace(/^models\//u, "") : rawId;
      if (!id || id.length > 8192 || id.trim() !== id || /[\r\n\0\ud800-\udfff]/u.test(id))
        throw new Error();
      const display = item[protocol === "gemini" ? "displayName" : "display_name"];
      if (display !== undefined && (typeof display !== "string" || display.length > 8192))
        throw new Error();
      const model: DiscoveredModel = {
        ...newProviderModel(id),
        name: typeof display === "string" ? display : id,
        reasoning: { supported: null, efforts: null },
      };
      if (protocol === "anthropic") anthropicCapabilities(model, item);
      if (protocol === "gemini" && item["thinking"] !== undefined) {
        if (typeof item["thinking"] !== "boolean") throw new Error();
        model.reasoning.supported = item["thinking"];
      }
      // 路由器只报告是否接受 reasoning 参数，并未报告各模型可用档位。
      const parameters = item["supported_parameters"];
      if (
        (protocol === "openai-chat" || protocol === "openai-responses") &&
        Array.isArray(parameters) &&
        parameters.every((value) => typeof value === "string")
      )
        if (parameters.includes("reasoning") || parameters.includes("reasoning_effort"))
          model.reasoning.supported = true;
      models.push(model);
    }
    let cursor: unknown = null;
    if (protocol === "gemini") cursor = raw["nextPageToken"] ?? null;
    else if (protocol === "anthropic" && raw["has_more"] === true) cursor = raw["last_id"];
    if (cursor !== null && (typeof cursor !== "string" || !cursor || cursor.length > 8192))
      throw new Error();
    return { models, cursor };
  } catch {
    throw new Error("模型列表格式无效");
  }
}

function support(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  const supported = record(value)["supported"];
  if (typeof supported !== "boolean") throw new Error("模型列表格式无效");
  return supported;
}

function anthropicCapabilities(model: DiscoveredModel, item: Record<string, unknown>): void {
  if (item["capabilities"] === undefined || item["capabilities"] === null) return;
  const capabilities = record(item["capabilities"]);
  const supported = support(capabilities["thinking"]);
  const effort = capabilities["effort"];
  let efforts: ReasoningCapability["efforts"] = null;
  if (effort !== undefined && effort !== null) {
    const raw = record(effort);
    efforts = support(raw)
      ? Object.keys(raw)
          .filter((level) => level !== "supported" && support(raw[level]) === true)
          .map(parseReasoningEffort)
      : [];
  }
  model.reasoning = { supported, efforts };
  const vision = support(capabilities["image_input"]);
  if (vision !== null) model.vision = vision;
}

async function ollamaCapabilities(
  models: DiscoveredModel[],
  base: URL,
  request: (url: URL, body?: object) => Promise<Record<string, unknown>>,
): Promise<void> {
  const url = new URL(base);
  url.pathname = `${base.pathname.replace(/\/+$/u, "")}/show`;
  // 详情接口逐模型查询；限制并发，同时沿用整个发现操作的时间及字节预算。
  for (let offset = 0; offset < models.length; offset += 4) {
    await Promise.all(
      models.slice(offset, offset + 4).map(async (model) => {
        const result = await request(url, { model: model.id });
        const capabilities = result["capabilities"];
        if (capabilities !== undefined) {
          if (
            !Array.isArray(capabilities) ||
            !capabilities.every((value) => typeof value === "string")
          )
            throw new Error("模型列表格式无效");
          model.tools = capabilities.includes("tools");
          model.vision = capabilities.includes("vision");
          model.reasoning.supported = capabilities.includes("thinking");
        }
        if (result["thinking"] !== undefined) {
          const values = record(result["thinking"])["values"];
          if (!Array.isArray(values) || values.length > 128) throw new Error("模型列表格式无效");
          model.reasoning = {
            supported: values.some((value) => value !== false),
            efforts: values.map((value) =>
              typeof value === "boolean" ? String(value) : parseReasoningEffort(value),
            ),
          };
          const initial = record(result["thinking"])["default"];
          if (initial !== undefined) {
            const defaultEffort =
              typeof initial === "boolean" ? String(initial) : parseReasoningEffort(initial);
            if (!model.reasoning.efforts?.includes(defaultEffort))
              throw new Error("模型列表格式无效");
            model.reasoning.defaultEffort = defaultEffort;
          }
        }
      }),
    );
  }
}
