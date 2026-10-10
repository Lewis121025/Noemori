import { record } from "./parse";
import type { Protocol } from "./api";
import { officialReasoning } from "./official-reasoning";
/** 对话显式选择的服务商原始档位名称；不翻译、不按本地枚举限制服务商的新档位。 */
export type ReasoningEffort = string;
/** 支持状态与档位列表独立；null 表示未报告，空列表仅表示没有可选档位，不用于拦截请求。 */
export type ReasoningCapability = {
  supported: boolean | null;
  efforts: ReasoningEffort[] | null;
  /** 官方能力接口明确报告的初始档位，必须属于可选列表。 */
  defaultEffort?: ReasoningEffort;
};

/**
 * @param value 未信任的推理档位。
 * @returns 可传递的具体档位。
 * @throws 名称不是长度为 1–128 的字母开头标识符时拒绝，不校验模型是否支持。
 */
export function parseReasoningEffort(value: unknown): ReasoningEffort {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/u.test(value))
    throw new Error("推理强度名称无效");
  return value;
}

/**
 * @param capability 官方能力接口报告的档位；本地模型以实际安装的模型能力为准。
 * @param modelId 完整模型标识，用于匹配官方逐型号契约。
 * @param protocol 实际请求协议，不将其他协议的参数套给模型。
 * @returns 官方原名档位；未知型号只使用明确报告的名称，缺失时返回空列表，不抛出异常。
 */
export function modelReasoningEfforts(
  capability?: ReasoningCapability,
  modelId?: string,
  protocol?: Protocol,
): readonly ReasoningEffort[] {
  if (protocol !== "ollama" || capability?.efforts == null) {
    const official = officialReasoning(modelId, protocol);
    if (official) return [...official.efforts];
  }
  return [...new Set(capability?.efforts ?? [])];
}

/**
 * @param modelId 完整模型标识。
 * @param protocol 实际请求协议。
 * @param effort 对话已经明确保存的档位；缺失时采用官方公布的具体初始值。
 * @param capability 官方能力接口返回的本地或自定义模型定义。
 * @returns 菜单与请求共用的具体档位；官方没有定义初始值时不擅自指定。
 * @throws 已知官方型号收到不属于其列表的显式档位时拒绝，不降级或透传非法值。
 */
export function resolveReasoningEffort(
  modelId: string,
  protocol: Protocol,
  effort?: ReasoningEffort,
  capability?: ReasoningCapability,
): ReasoningEffort | undefined {
  const official = officialReasoning(modelId, protocol);
  if (protocol === "ollama" && capability?.efforts != null)
    return effort ?? capability.defaultEffort;
  if (official && effort !== undefined && !official.efforts.includes(effort))
    throw new Error(
      `模型 ${modelId} 不支持推理强度 ${effort}，可选：${official.efforts.join("、")}`,
    );
  return effort ?? (official ? official.defaultEffort : capability?.defaultEffort);
}

/**
 * @param value 磁盘或 IPC 中的模型推理能力。
 * @returns 独立能力描述；未知能力保留为 null。
 * @throws 类型、数量、档位重复或初始值不属于档位列表时拒绝。
 */
export function parseReasoningCapability(value: unknown): ReasoningCapability {
  const input = record(value);
  const supported = input["supported"],
    raw = input["efforts"];
  if (supported !== null && typeof supported !== "boolean") throw new Error("推理能力无效");
  if (raw !== null && (!Array.isArray(raw) || raw.length > 128))
    throw new Error("推理档位列表无效");
  const efforts = raw === null ? null : raw.map(parseReasoningEffort);
  if (efforts && new Set(efforts).size !== efforts.length) throw new Error("推理档位重复");
  const defaultEffort =
    input["defaultEffort"] === undefined ? undefined : parseReasoningEffort(input["defaultEffort"]);
  if (defaultEffort !== undefined && !efforts?.includes(defaultEffort))
    throw new Error("初始推理强度不属于可选档位");
  return { supported, efforts, ...(defaultEffort === undefined ? {} : { defaultEffort }) };
}
