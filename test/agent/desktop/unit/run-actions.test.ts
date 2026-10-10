import { expect, it } from "vitest";
import type { AgentRun } from "../../../../modules/notes/packages/desktop/src/features/agent/shared/api";
import {
  canResumeRun,
  isActiveRun,
} from "../../../../modules/notes/packages/desktop/src/features/agent/shared/run-actions";

it("运行和等待用户仍属于当前轮次，空会话与所有终态不占用当前轮次", () => {
  expect(isActiveRun(null)).toBe(false);
  expect(isActiveRun(undefined)).toBe(false);
  const states: AgentRun["status"][] = [
    "running",
    "paused",
    "completed",
    "cancelled",
    "timed_out",
    "budget_exhausted",
    "truncated",
    "filtered",
    "failed",
  ];
  for (const status of states) {
    const run: AgentRun = { id: "current", status, error: null, model_calls: 2 };
    expect(isActiveRun(run), status).toBe(status === "running" || status === "paused");
    if (isActiveRun(run))
      expect(run).toEqual({ id: "current", status, error: null, model_calls: 2 });
    expect(canResumeRun(run), status).toBe(
      ["cancelled", "timed_out", "budget_exhausted", "truncated", "failed"].includes(status),
    );
  }
});
