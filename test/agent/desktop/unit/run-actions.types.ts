import type { AgentRun } from "../../../../modules/notes/packages/desktop/src/features/agent/shared/api";
import { isActiveRun } from "../../../../modules/notes/packages/desktop/src/features/agent/shared/run-actions";

// 本文件只参加类型检查；活动状态必须同时证明运行身份完整，不能靠断言补全字段。
declare const run: AgentRun | null | undefined;
if (isActiveRun(run)) {
  const active: AgentRun = run;
  const status: "running" | "paused" = run.status;
  const id: string = run.id;
  void active;
  void status;
  void id;
}
