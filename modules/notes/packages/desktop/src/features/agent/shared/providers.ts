import type { Authentication, ModelSettings, Protocol, PublicModelSettings } from "./api";
import { boolean, parseAuthentication, parseProtocol, record, text } from "./parse";

/** 模型标识在所属供应商内唯一；能力由用户声明，不根据名称猜测。 */
export type ProviderModel = { id: string } & Pick<
  ModelSettings,
  "tools" | "streaming" | "vision" | "audio" | "video"
>;
/** Base URL 包含 API 版本路径；完整地址可用 {model} 表达部署路径中的模型。 */
export type ProviderAddress = { type: "base_url" | "endpoint"; url: string };
/** 一套已保存连接拥有独立认证及至少一个模型，品牌预设只负责初始化填写。 */
export type ProviderSettings = {
  id: string;
  name: string;
  protocol: Protocol;
  address: ProviderAddress;
  authentication: Authentication;
  models: [ProviderModel, ...ProviderModel[]];
};
/** 可编辑输入允许临时空模型列表，提交时验证；null 认证仅保留指定连接的凭据。 */
export type ProviderUpdate = Omit<ProviderSettings, "id" | "authentication" | "models"> & {
  id: string | null;
  authentication: Authentication | null;
  models: ProviderModel[];
};
/** 供应商列表只返回认证描述，不返还认证原文或密文。 */
export type PublicProvider = Omit<ProviderSettings, "authentication"> & {
  authentication: PublicModelSettings["authentication"];
};
/** 默认模型同时绑定供应商身份，防止同名模型混用不同账号。 */
export type ModelSelection = { providerId: string; modelId: string };
/** 空目录或删除默认模型后 active 为 null，需要用户明确选择。 */
export type ProviderCatalog = { providers: PublicProvider[]; active: ModelSelection | null };

/**
 * 创建待用户确认能力的独立草稿，不根据模型名称推断服务商支持情况。
 * @param id 服务商模型标识；空字符串仅供尚未填写的草稿使用。
 * @returns 可编辑模型草稿，不抛出异常。
 */
export function newProviderModel(id = ""): ProviderModel {
  return { id, tools: true, streaming: true, vision: false, audio: false, video: false };
}

/**
 * 将用户明确选择的地址模式解析为原生完整 URL，保留网关路径与查询参数。
 * @param protocol 请求协议。
 * @param address 用户明确选择的基础或完整地址。
 * @param model 供应商接受的模型标识，只用于路径占位。
 * @returns 原生模型使用的完整请求地址。
 * @throws 非 HTTP(S)、内嵌凭据、片段或缺少云部署路径时拒绝。
 */
export function providerEndpoint(
  protocol: Protocol,
  address: ProviderAddress,
  model: string,
): string {
  const url = new URL(address.url);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash)
    throw new Error("接口地址必须是无内嵌凭据和片段的 HTTP(S) URL");
  if (address.type === "endpoint") {
    // 仅替换路径，账号、域名和查询参数不能由模型标识改变。
    url.pathname = url.pathname.replace(/%7bmodel%7d|\{model\}/giu, encodeURIComponent(model));
    return url.href;
  }
  let path: string;
  switch (protocol) {
    case "openai-chat":
      path = "chat/completions";
      break;
    case "openai-responses":
      path = "responses";
      break;
    case "anthropic":
      path = "messages";
      break;
    case "gemini":
      path = `models/${encodeURIComponent(model)}:generateContent`;
      break;
    case "ollama":
      path = "chat";
      break;
    case "vertex-anthropic":
    case "bedrock":
      throw new Error("云部署协议需要填写完整接口地址");
  }
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/${path}`;
  return url.href;
}

/**
 * 验证 IPC 和磁盘共用的供应商契约，返回规范输入。
 * @param value 未信任的供应商记录。
 * @returns 已校验并去除名称、地址和模型标识首尾空白的配置。
 * @throws 名称、模型、地址、认证或数量超出约束时拒绝，不修补错误输入。
 */
export function parseProviderUpdate(
  value: unknown,
): ProviderUpdate & Pick<ProviderSettings, "models"> {
  const input = record(value);
  const id = input["id"] === null ? null : text(input, "id");
  const name = text(input, "name").trim();
  if ((id !== null && (!id || id.length > 128)) || !name || name.length > 128)
    throw new Error("供应商名称或标识无效");
  const rawAddress = record(input["address"]);
  const type = text(rawAddress, "type");
  if (type !== "base_url" && type !== "endpoint") throw new Error("接口地址模式无效");
  const address: ProviderAddress = { type, url: text(rawAddress, "url").trim() };
  if (address.url.length > 8192) throw new Error("接口地址过长");
  const protocol = parseProtocol(text(input, "protocol"));
  const rawModels = input["models"];
  if (!Array.isArray(rawModels) || rawModels.length < 1 || rawModels.length > 256)
    throw new Error("每个供应商需要 1 到 256 个模型");
  const ids = new Set<string>();
  const models: [ProviderModel, ...ProviderModel[]] = [
    parseProviderModel(rawModels[0]),
    ...rawModels.slice(1).map(parseProviderModel),
  ];
  for (const model of models) {
    if (ids.has(model.id)) throw new Error("模型标识不能重复");
    ids.add(model.id);
    providerEndpoint(protocol, address, model.id);
  }
  if (
    address.type === "endpoint" &&
    models.length > 1 &&
    ["gemini", "bedrock", "vertex-anthropic"].includes(protocol) &&
    !/%7bmodel%7d|\{model\}/iu.test(new URL(address.url).pathname)
  )
    throw new Error("此协议的多个模型需要在完整地址路径中使用 {model} 占位");
  const authentication =
    input["authentication"] === null ? null : parseAuthentication(input["authentication"]);
  if (authentication === null && id === null) throw new Error("新增供应商必须明确配置认证");
  return { id, name, protocol, address, authentication, models };
}

function parseProviderModel(value: unknown): ProviderModel {
  const item = record(value),
    id = text(item, "id").trim();
  if (!id || id.length > 8192 || /[\r\n\0\ud800-\udfff]/u.test(id)) throw new Error("模型标识无效");
  return {
    id,
    tools: boolean(item, "tools"),
    streaming: boolean(item, "streaming"),
    vision: boolean(item, "vision"),
    audio: boolean(item, "audio"),
    video: boolean(item, "video"),
  };
}

/**
 * @param value 来自 IPC 的供应商与模型身份。
 * @returns 类型和长度有效的独立选择对象，引用闭合由目录入口验证。
 * @throws 缺失、空值或超长身份时拒绝。
 */
export function parseModelSelection(value: unknown): ModelSelection {
  const input = record(value);
  const providerId = text(input, "providerId"),
    modelId = text(input, "modelId");
  if (!providerId || providerId.length > 128 || !modelId || modelId.length > 8192)
    throw new Error("默认模型标识无效");
  return { providerId, modelId };
}
