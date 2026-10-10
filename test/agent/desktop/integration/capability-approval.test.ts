/** @vitest-environment jsdom */
import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, it, vi } from "vitest";
import ApprovalCard from "../../../../modules/notes/packages/desktop/src/features/agent/renderer/ApprovalCard.svelte";
import type { AgentApproval } from "../../../../modules/notes/packages/desktop/src/features/agent/shared/api";

let component: ReturnType<typeof mount> | undefined;
let target: HTMLDivElement;
afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  target?.remove();
});

function show(pending: AgentApproval) {
  target = document.createElement("div");
  document.body.append(target);
  const onApprove = vi.fn();
  component = mount(ApprovalCard, {
    target,
    props: { pending, count: 1, approving: false, onApprove },
  });
  flushSync();
  return onApprove;
}

it.each([
  ["webmcp", "网页工具", "修改网站数据"],
  ["developer_logs", "页面日志", "日志"],
  ["cdp", "页面诊断", "只读"],
] as const)("明确展示%s能力与有效范围，并只提交当前审批", (capability, label, explanation) => {
  const pending: AgentApproval = {
    id: "approval-one",
    request: {
      type: "browser_capability",
      request: {
        backend: "managed",
        page: "page-one",
        document: "document-one",
        origin: "https://example.com",
        title: "工单系统",
        capability,
        reason: "核验本次任务",
      },
    },
  };
  const approve = show(pending);
  expect(target.textContent).toContain(label);
  expect(target.textContent).toContain(explanation);
  expect(target.textContent).toContain("https://example.com");
  expect(target.textContent).toContain("工单系统");
  expect(target.textContent).toContain("导航或接管后失效");
  const buttons = [...target.querySelectorAll("button")];
  expect(buttons.some((button) => button.textContent?.includes("批准本次"))).toBe(false);
  buttons.find((button) => button.textContent?.includes("此会话允许"))?.click();
  expect(approve).toHaveBeenCalledExactlyOnceWith(pending, "allow_for_session");
});

it("启动应用仅展示一次批准，并明确后续操作仍须授权", () => {
  const pending: AgentApproval = {
    id: "launch-one",
    request: {
      type: "ui_launch",
      request: {
        bundle_id: "app.example.Editor",
        app_name: "测试编辑器",
        reason: "打开验收应用",
      },
    },
  };
  const approve = show(pending);
  expect(target.textContent).toContain("启动应用");
  expect(target.textContent).toContain("测试编辑器");
  expect(target.textContent).toContain("不授予窗口控制权");
  const buttons = [...target.querySelectorAll("button")];
  expect(buttons.some((button) => button.textContent?.includes("此会话允许"))).toBe(false);
  buttons.find((button) => button.textContent?.includes("批准本次"))?.click();
  expect(approve).toHaveBeenCalledExactlyOnceWith(pending, "allow_once");
});
