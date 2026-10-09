import { record } from "./parse";

/** 常见官方档位候选；模型报告的其他名称也可选择，none 与省略参数不同。 */
export const reasoningEfforts = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
/** 对话显式选择的官方参数名称；不翻译、不按本地枚举限制服务商的新档位。 */
export type ReasoningEffort = string;
/** null 表示接口未报告；空档位列表表示接口明确不支持调节。 */
export type ReasoningCapability = {
  supported: boolean | null;
  efforts: ReasoningEffort[] | null;
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
 * @param capability 接口报告的能力元数据，不作为请求拦截依据。
 * @param modelId 完整模型标识；已核对的官方模型采用其公开档位，不按前缀猜测其他模型。
 * @returns 官方候选与模型报告的全部原名，去重且不改变大小写，不抛出异常。
 */
export function modelReasoningEfforts(
  capability?: ReasoningCapability,
  modelId?: string,
): readonly ReasoningEffort[] {
  // GPT-6 Sol 的官网明确列出六档，通用协议中的 minimal 不属于其官方候选。
  // 来源：https://developers.openai.com/api/docs/models/gpt-6-sol
  const candidates =
    modelId === "gpt-6-sol"
      ? reasoningEfforts.filter((effort) => effort !== "minimal")
      : reasoningEfforts;
  return [...new Set([...candidates, ...(capability?.efforts ?? [])])];
}

/**
 * @param value 磁盘或 IPC 中的模型推理能力。
 * @returns 独立能力描述；未知能力保留为 null。
 * @throws 类型、数量或档位重复时拒绝。
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
  return { supported, efforts };
}
