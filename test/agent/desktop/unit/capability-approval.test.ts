import { expect, it } from "vitest";
import {
  parseApprovalReply,
  parseSnapshot,
} from "../../../../modules/notes/packages/desktop/src/features/agent/shared/parse";

const details = {
  backend: "managed",
  page: "page-one",
  document: "document-one",
  origin: "https://example.com",
  title: "工单系统",
  capability: "webmcp",
  reason: "按要求更新工单",
};

function snapshot(request: unknown): string {
  return JSON.stringify({
    id: "session",
    workspace: "/workspace",
    revision: 1,
    closed: false,
    run: null,
    turns: [],
    messages: [],
    terminals: [],
    approvals: [{ id: "approval-one", request }],
    browser: { status: "idle", tabs: [], receipts: [], error: null },
  });
}

it.each(["webmcp", "developer_logs", "cdp"])(
  "能力审批保留可信页面身份和申请范围：%s",
  (capability) => {
    const request = { type: "browser_capability", request: { ...details, capability } };
    expect(parseSnapshot(snapshot(request)).approvals).toEqual([{ id: "approval-one", request }]);
  },
);

it("未知后端、未知能力及缺失文档身份不能成为可批准的请求", () => {
  for (const invalid of [
    { ...details, backend: "computer" },
    { ...details, capability: "all" },
    { ...details, document: undefined },
  ])
    expect(() =>
      parseSnapshot(snapshot({ type: "browser_capability", request: invalid })),
    ).toThrow();
});

it("扩展能力决定不能借用一次性或终端前缀授权", () => {
  for (const decision of [
    { decision: "allow_once" },
    { decision: "allow_prefix", details: { prefix: ["all"] } },
  ])
    expect(() => parseApprovalReply({ type: "browser_capability", decision })).toThrow();
  for (const decision of [
    { decision: "allow_for_session" },
    { decision: "deny", details: "用户拒绝" },
  ])
    expect(parseApprovalReply({ type: "browser_capability", decision })).toEqual({
      type: "browser_capability",
      decision,
    });
});

it("启动应用审批仅批准本次启动，不能持久扩展应用访问范围", () => {
  const request = {
    type: "ui_launch",
    request: { bundle_id: "app.example.Editor", app_name: "测试编辑器", reason: "打开待验收应用" },
  };
  expect(parseSnapshot(snapshot(request)).approvals[0]?.request).toEqual(request);
  expect(parseApprovalReply({ type: "ui_launch", decision: { decision: "allow_once" } })).toEqual({
    type: "ui_launch",
    decision: { decision: "allow_once" },
  });
  expect(() =>
    parseApprovalReply({ type: "ui_launch", decision: { decision: "allow_for_session" } }),
  ).toThrow();
});
