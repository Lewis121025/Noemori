import type { AgentSnapshot } from "./api";

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
