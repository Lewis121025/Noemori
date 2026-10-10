import type { AgentRun, AgentSnapshot } from "./api";

/**
 * 活动运行包含等待用户的暂停态；用于冻结本轮模型、阻止队列抢占和保护轮次边界。
 * @param run 最近运行；空会话允许 null 或 undefined。
 * @returns 活动时同时证明运行身份完整，并收窄为 running 或 paused；不修改状态，不抛异常。
 */
export function isActiveRun(
  run: AgentSnapshot["run"] | undefined,
): run is AgentRun & { status: "running" | "paused" } {
  return run?.status === "running" || run?.status === "paused";
}

/**
 * 确定最近一轮是否可以由用户明确继续；完成、运行中与内容过滤不作为可重试状态。
 * @param run 当前会话最近运行，尚无运行时为 null。
 * @returns 可继续时为 true；不读取或修改状态，不抛出异常。
 */
export function canResumeRun(run: AgentSnapshot["run"]): boolean {
  return (
    run !== null &&
    ["cancelled", "timed_out", "budget_exhausted", "truncated", "failed"].includes(run.status)
  );
}
