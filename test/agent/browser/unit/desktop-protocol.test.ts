import { expect, it } from "vitest";
import { parseSnapshot } from "../../../../modules/notes/packages/desktop/src/features/agent/shared/parse";

function snapshot(outcome = "not_executed") {
  return JSON.stringify({
    id: "session",
    workspace: "/workspace",
    revision: 3,
    closed: false,
    run: null,
    messages: [],
    terminals: [],
    approvals: [],
    browser: {
      status: "ready",
      tabs: [],
      error: null,
      receipts: [
        {
          call_id: "batch",
          action: "batch",
          outcome: "unknown",
          error: "页面重绘",
          steps: [
            { index: 0, action: "fill", outcome: "executed" },
            { index: 1, action: "click", outcome, error: "控件已替换" },
          ],
        },
      ],
    },
  });
}

it("取消后的批量回执保留执行过与未执行步骤，供窗口恢复和人工接管判断", () => {
  const result = parseSnapshot(snapshot());
  expect(result.browser.receipts[0]?.steps).toEqual([
    { index: 0, action: "fill", outcome: "executed", error: null },
    { index: 1, action: "click", outcome: "not_executed", error: "控件已替换" },
  ]);
});

it("窗口拒绝未知步骤状态，不能把无效回执当作已完成", () => {
  expect(() => parseSnapshot(snapshot("finished"))).toThrow("执行阶段");
});
