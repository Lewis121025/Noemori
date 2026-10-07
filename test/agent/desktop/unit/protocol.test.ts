import { expect, it } from "vitest";
import {
  parseSnapshot,
  parseTerminalPage,
} from "../../../../modules/notes/packages/desktop/src/features/agent/shared/parse";

function snapshot(process: object): string {
  return JSON.stringify({
    id: "session",
    workspace: "/workspace",
    revision: 1,
    closed: false,
    run: null,
    messages: [],
    approvals: [],
    browser: { status: "idle", tabs: [], receipts: [], error: null },
    terminals: [{ call_id: "exec", process, bytes: 5, tty: true, error: null }],
  });
}

it.each([
  [
    { session_id: "terminal", status: "running" },
    { exit_code: null, signal: null, error: null },
  ],
  [
    { session_id: "terminal", status: "exited", exit_code: 0 },
    { exit_code: 0, signal: null, error: null },
  ],
  [
    { session_id: "terminal", status: "stopped", signal: "SIGTERM" },
    { exit_code: null, signal: "SIGTERM", error: null },
  ],
])("原生终端省略未确定字段时仍能投影进程状态：%j", (process, expected) => {
  expect(parseSnapshot(snapshot(process)).terminals[0]?.process).toMatchObject(expected);
});

it("可选字段省略不等于接受错误类型，非法终端状态必须拒绝", () => {
  expect(() =>
    parseSnapshot(snapshot({ session_id: "terminal", status: "exited", exit_code: "0" })),
  ).toThrow("退出码");
  expect(() =>
    parseSnapshot(snapshot({ session_id: "terminal", status: "failed", error: 1 })),
  ).toThrow("字符串");
});

it("原生日志页的扁平进程状态与无损字节游标投影到窗口协议", () => {
  const page = parseTerminalPage(
    JSON.stringify({
      session_id: "terminal",
      status: "running",
      offset: 0,
      next_offset: 5,
      total_bytes: 5,
      has_more: false,
      chunks: [{ stream: "terminal", data_base64: "aGVsbG8=", offset: 0, next_offset: 5 }],
    }),
  );
  expect(page.process).toEqual({
    session_id: "terminal",
    status: "running",
    exit_code: null,
    signal: null,
    error: null,
  });
  expect(page.chunks).toEqual([
    { stream: "terminal", data_base64: "aGVsbG8=", offset: 0, next_offset: 5 },
  ]);
  expect(page.next_offset).toBe(5);
});
