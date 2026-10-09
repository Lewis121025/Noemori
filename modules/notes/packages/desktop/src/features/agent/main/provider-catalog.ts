import type { ModelSettings } from "../shared/api";
import type {
  ModelSelection,
  ProviderCatalog,
  ProviderModel,
  PublicProvider,
} from "../shared/providers";
import { parseModelSelection, parseProviderUpdate, providerEndpoint } from "../shared/providers";
import { parseAuthenticationDescription, record, text } from "../shared/parse";
import { authenticationDescription, decryptAuthentication, parseProtectedModel } from "./settings";

/** 公开连接与系统密文成对保存；模型归属根据实际连接计算，不依赖人为修订号。 */
export type StoredProvider = { provider: PublicProvider; encrypted: string | null };
/** active 仅作为旧版对话迁移来源，新版选择保存在对话中。 */
export type StoredCatalog = { providers: StoredProvider[]; active: ModelSelection | null };
/** 单次目录快照中解析出的确定连接与模型，避免重复查找和非空断言。 */
export type SelectedProvider = {
  record: StoredProvider;
  model: ProviderModel;
  selection: ModelSelection;
};

/**
 * 解码供应商磁盘契约，版本二不解密；旧版认证类型只能从系统密文恢复。
 * @param value 未信任的磁盘 JSON。
 * @returns 身份唯一、认证描述有效且选择引用闭合的目录。
 * @throws 版本、连接、描述、选择无效，或旧版认证无法解密时拒绝。
 */
export function parseStoredCatalog(value: unknown): StoredCatalog {
  const raw = record(value);
  if (raw["version"] === 1) return migrateLegacy(raw);
  if (raw["version"] !== 2) throw new Error("Agent 供应商设置版本不支持");
  const values = raw["providers"];
  if (!Array.isArray(values) || values.length > 128) throw new Error("供应商目录无效");
  const providers = values.map(parseStoredProvider);
  if (new Set(providers.map((entry) => entry.provider.id)).size !== providers.length)
    throw new Error("供应商标识重复");
  const active = raw["active"] === null ? null : parseModelSelection(raw["active"]);
  const catalog = { providers, active };
  if (active) requireModelSelection(catalog, active);
  return catalog;
}

function parseStoredProvider(value: unknown): StoredProvider {
  const item = record(value),
    visible = record(item["provider"]);
  const parsed = parseProviderUpdate({ ...visible, authentication: { type: "none" } });
  if (parsed.id === null) throw new Error("供应商标识无效");
  const authentication = parseAuthenticationDescription(visible["authentication"]);
  const encrypted = item["encrypted"] === null ? null : text(item, "encrypted");
  if (authentication.configured !== (encrypted !== null)) throw new Error("认证描述与密文不一致");
  return { provider: { ...parsed, id: parsed.id, authentication }, encrypted };
}

/**
 * 在确定目录快照中解析选择，缺失引用不得降级为另一模型或未配置状态。
 * @param catalog 已解码的目录。
 * @param selection 用户确认的供应商与模型身份。
 * @returns 对应的连接记录及模型。
 * @throws 供应商或模型不存在时拒绝；推理档位是否支持交由网关判断。
 */
export function requireModelSelection(
  catalog: StoredCatalog,
  selection: ModelSelection,
): SelectedProvider {
  const stored = catalog.providers.find((entry) => entry.provider.id === selection.providerId);
  const model = stored?.provider.models.find((model) => model.id === selection.modelId);
  if (!stored || !model) throw new Error("所选供应商或模型已不可用，请重新选择模型");
  return { record: stored, model, selection };
}

/**
 * 私有模型构造与公开配置共用同一映射，保持模型、路径和能力一致。
 * @param selected 已解析的选择。
 * @returns 不含认证的原生模型参数。
 * @throws 地址不能解析为协议请求路径时拒绝。
 */
export function modelParameters(selected: SelectedProvider): Omit<ModelSettings, "authentication"> {
  const { provider } = selected.record,
    model = selected.model;
  return {
    protocol: provider.protocol,
    model: model.id,
    endpoint: providerEndpoint(provider.protocol, provider.address, model.id),
    tools: model.tools,
    streaming: model.streaming,
    vision: model.vision,
    audio: model.audio,
    video: model.video,
    ...(selected.selection.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: selected.selection.reasoningEffort }),
  };
}

/**
 * 将目录投影给界面，不暴露系统密文，也不解密。
 * @param catalog 本次读取或提交的完整目录。
 * @returns 无密钥的连接目录，不包含对话选择。
 */
export function projectCatalog(catalog: StoredCatalog): ProviderCatalog {
  return { providers: catalog.providers.map((entry) => entry.provider) };
}

function migrateLegacy(value: Record<string, unknown>): StoredCatalog {
  const protectedModel = parseProtectedModel(value);
  const { protocol, endpoint, model: id, ...capabilities } = protectedModel.settings;
  const authentication = authenticationDescription(
    decryptAuthentication(protectedModel.authentication),
  );
  return {
    providers: [
      {
        provider: {
          id: "legacy",
          name: "原有配置",
          protocol,
          address: { type: "endpoint", url: endpoint },
          models: [{ id, ...capabilities }],
          authentication,
        },
        encrypted: protectedModel.authentication,
      },
    ],
    active: { providerId: "legacy", modelId: id },
  };
}
