import { record } from "./parse";
/** 对话显式选择的服务商原始档位名称；不翻译、不按本地枚举限制服务商的新档位。 */
export type ReasoningEffort = string;
/** 支持状态与档位列表独立；null 表示未报告，空列表仅表示没有可选档位，不用于拦截请求。 */
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
 * @param capability 模型接口明确报告的档位，不作为请求拦截依据。
 * @returns 接口报告的原名，去重且不改变大小写；缺失时返回空列表，不按模型名推断，不抛出异常。
 */
export function modelReasoningEfforts(
  capability?: ReasoningCapability,
): readonly ReasoningEffort[] {
  return [...new Set(capability?.efforts ?? [])];
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
