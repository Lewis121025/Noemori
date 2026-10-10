import type { Observation } from "./contract.js";

/** 显式观察只接受完整或增量；基线由调用者实际保留的观察标识确定。 */
export type ObservationRequest = { mode?: "full" | "delta"; baseline?: string };

/** 动作后可省略采集，但省略时必须同时撤销旧引用和截图定位。 */
export type ObservationPolicy = "full" | "delta" | "none";

/** 更新必须携带新身份与截断事实；变化字段整体替换，不能追加到旧引用表。 */
export type ObservationUpdate =
  | {
      kind: "full";
      id: string;
      target: string;
      truncated: boolean;
      reset_reason: "missing_baseline" | "baseline_mismatch" | "invalidated";
    }
  | {
      kind: "delta" | "unchanged";
      id: string;
      target: string;
      base: string;
      truncated: boolean;
      changes: Partial<Omit<Observation, "id" | "page">>;
    };

/** 完整正文和增量互斥，避免重复传输；后端仍独占保存完整观察以核验真实引用。 */
export type ObservationResult = {
  observation?: Observation;
  observation_update?: ObservationUpdate;
};

/**
 * 将已采集的当前观察编码为完整结果或可还原的字段变化，不决定是否采集。
 * @param previous 当前目标仍有效的上一观察；失效后必须传 null。
 * @param current 本次真实采集并登记的新观察。
 * @param request 调用者选择的模式与其保留的基线。
 * @returns 完整观察，或以精确基线为前置条件的更新；无变化也更新观察身份。
 */
export function observationResult(
  previous: Observation | null,
  current: Observation,
  request: ObservationRequest = {},
): ObservationResult {
  if (request.mode !== "delta") return { observation: current };
  const full = (
    reset: "missing_baseline" | "baseline_mismatch" | "invalidated",
  ): ObservationResult => ({
    observation: current,
    observation_update: {
      kind: "full",
      id: current.id,
      target: current.page,
      truncated: current.truncated,
      reset_reason: reset,
    },
  });
  const baseline = request.baseline;
  if (!baseline) return full("missing_baseline");
  if (!previous || previous.page !== current.page) return full("invalidated");
  if (previous.id !== baseline) return full("baseline_mismatch");
  const changes: Partial<Omit<Observation, "id" | "page">> = {};
  for (const key of [
    "url",
    "title",
    "text",
    "elements",
    "warnings",
    "viewport",
    "truncated",
  ] as const) {
    if (JSON.stringify(previous[key]) !== JSON.stringify(current[key]))
      Object.assign(changes, { [key]: current[key] });
  }
  return {
    observation_update: {
      kind: Object.keys(changes).length ? "delta" : "unchanged",
      id: current.id,
      target: current.page,
      base: baseline,
      truncated: current.truncated,
      changes,
    },
  };
}
