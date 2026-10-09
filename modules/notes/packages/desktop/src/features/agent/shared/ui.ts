import type { AgentUi } from "./api";
import { array, record, text, integer, nullableText, boolean } from "./values";

/** 空资源快照用于旧记录和重启，禁止凭保存的 UI 状态恢复控制权。 */
export function emptyUi(): AgentUi {
  return {
    status: "idle",
    generation: 0,
    call: null,
    error: null,
    connections: [],
    receipts: [],
    control: null,
  };
}
/** 校验 Rust UI 投影；未知状态拒绝，历史缺少此字段时返回空资源。 */
export function parseUi(value: unknown): AgentUi {
  if (value === undefined) return emptyUi();
  const item = record(value);
  const status = text(item, "status");
  if (
    status !== "idle" &&
    status !== "ready" &&
    status !== "busy" &&
    status !== "failed" &&
    status !== "closed"
  )
    throw new Error("界面执行状态无效");
  const control = item["control"] === null ? null : record(item["control"]);
  return {
    status,
    generation: integer(item, "generation"),
    call: nullableText(item, "call"),
    error: nullableText(item, "error"),
    connections: array(item["connections"]).map((raw) => {
      const value = record(raw);
      const backend = text(value, "backend");
      if (backend !== "chrome" && backend !== "edge" && backend !== "computer")
        throw new Error("界面连接后端无效");
      return {
        id: text(value, "id"),
        backend,
        name: text(value, "name"),
        connected: boolean(value, "connected"),
        human: boolean(value, "human"),
        tabs: array(value["tabs"]).map((raw) => {
          const tab = record(raw);
          return { id: text(tab, "id"), title: text(tab, "title"), url: text(tab, "url") };
        }),
      };
    }),
    receipts: array(item["receipts"]).map((raw) => {
      const value = record(raw);
      const outcome = text(value, "outcome");
      if (
        outcome !== "observed" &&
        outcome !== "executed" &&
        outcome !== "not_executed" &&
        outcome !== "unknown"
      )
        throw new Error("界面回执阶段无效");
      return {
        id: text(value, "id"),
        backend: text(value, "backend"),
        action: text(value, "action"),
        outcome,
        pending: boolean(value, "pending"),
        error: nullableText(value, "error"),
      };
    }),
    control: control
      ? {
          app: text(control, "app"),
          window: text(control, "window"),
          reason: text(control, "reason"),
          app_name: text(control, "app_name"),
          window_title: text(control, "window_title"),
        }
      : null,
  };
}
