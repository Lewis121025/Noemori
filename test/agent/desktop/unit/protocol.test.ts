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
    turns: [],
    messages: [],
    approvals: [],
    browser: { status: "idle", tabs: [], receipts: [], error: null },
    terminals: [{ call_id: "exec", process, bytes: 5, tty: true, error: null }],
  });
}

it("恢复尝试以运行身份关联前次中断，允许空范围与助手开头，拒绝伪造关联", () => {
  const base = JSON.parse(snapshot({ session_id: "terminal", status: "exited" }));
  const prior = { id: "stopped", status: "cancelled", error: null, model_calls: 1 };
  const run = { id: "resumed", status: "running", error: null, model_calls: 0 };
  const messages = [{ role: "user", content: [{ type: "text", value: "原任务" }] }];
  const first = { run: prior, message_start: 0, message_end: 1 };
  const resumed = { run, message_start: 1, message_end: 1, resumed_from: prior.id };
  const value = { ...base, run, messages, turns: [first, resumed] };
  expect(parseSnapshot(JSON.stringify(value)).turns[1]?.resumed_from).toBe(prior.id);
  const answer = { role: "assistant", content: [{ type: "text", value: "重新生成" }] };
  expect(parseSnapshot(JSON.stringify({ ...value, messages: [...messages, answer], turns: [first, { ...resumed, message_end: 2 }] })).messages).toHaveLength(2);
  for (const resumed_from of [undefined, "other", run.id]) {
    expect(() => parseSnapshot(JSON.stringify({ ...value, turns: [first, { ...resumed, resumed_from }] }))).toThrow("轮次边界");
  }
  expect(() => parseSnapshot(JSON.stringify({ ...value, turns: [{ ...first, run: { ...prior, status: "completed" } }, resumed] }))).toThrow("轮次边界");
});

it("工具媒体在窗口投影中保持顺序，旧截图字段只在读取边界迁移", () => {
  const base = JSON.parse(snapshot({ session_id: "terminal", status: "exited" }));
  const image = { format: "png", data: "aGVsbG8=" };
  const media = [{ type: "image", value: image }, { type: "audio", value: { format: "wav", source: { type: "bytes", value: [1, 2] } } }];
  const result = { call_id: "one", name: "browser", output: {}, is_error: false, media };
  const messages = [{ role: "tool", content: [{ type: "tool_result", value: result }] }];
  expect(parseSnapshot(JSON.stringify({ ...base, messages })).messages[0]?.content[0]).toMatchObject({ value: { media } });
  const legacy = { ...result, media: undefined, images: [image] };
  expect(parseSnapshot(JSON.stringify({ ...base, messages: [{ role: "tool", content: [{ type: "tool_result", value: legacy }] }] })).messages[0]?.content[0]).toMatchObject({ value: { media: [{ type: "image", value: image }] } });
  expect(() => parseSnapshot(JSON.stringify({ ...base, messages: [{ role: "tool", content: [{ type: "tool_result", value: { ...result, media: "broken" } }] }] }))).toThrow();
});

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

const bytesChunk = { stream: "stdout", data_base64: "AP+A", offset: 7, next_offset: 10 };
const bytesPage = {
  session_id: "terminal",
  status: "running",
  offset: 7,
  next_offset: 10,
  total_bytes: 14,
  has_more: true,
  chunks: [bytesChunk],
};

it("原始分页游标、分片字节跨度和后续标志必须形成闭合区间", () => {
  for (const invalid of [
    { ...bytesPage, offset: 11 },
    { ...bytesPage, next_offset: 15 },
    { ...bytesPage, next_offset: 9 },
    { ...bytesPage, has_more: false },
    { ...bytesPage, chunks: [] },
    { ...bytesPage, chunks: [{ ...bytesChunk, offset: 8 }] },
    { ...bytesPage, chunks: [{ ...bytesChunk, next_offset: 9 }] },
    {
      ...bytesPage,
      next_offset: 13,
      chunks: [bytesChunk, { stream: "stderr", data_base64: "AP+A", offset: 11, next_offset: 13 }],
    },
    {
      ...bytesPage,
      next_offset: 13,
      chunks: [bytesChunk, { stream: "stderr", data_base64: "AP+A", offset: 9, next_offset: 13 }],
    },
    ...["invalid!", "AP+A=", "", "Zh==", "Zm9="].map((data_base64) => ({
      ...bytesPage,
      chunks: [{ ...bytesChunk, data_base64 }],
    })),
  ])
    expect(() => parseTerminalPage(JSON.stringify(invalid))).toThrow();
});

it("混合输出保留原始字节，完整空页及零预算的未完成快照仍是合法原生页面", () => {
  const mixed = {
    ...bytesPage,
    offset: 4,
    next_offset: 9,
    chunks: [
      { stream: "stdout", data_base64: "8J8=", offset: 4, next_offset: 6 },
      { stream: "stderr", data_base64: "AP8A", offset: 6, next_offset: 9 },
    ],
  };
  expect(parseTerminalPage(JSON.stringify(mixed)).chunks).toEqual(mixed.chunks);
  for (const total_bytes of [7, 14]) {
    const empty = {
      ...bytesPage,
      chunks: [],
      next_offset: 7,
      total_bytes,
      has_more: total_bytes > 7,
    };
    expect(parseTerminalPage(JSON.stringify(empty))).toMatchObject({
      offset: 7,
      next_offset: 7,
      total_bytes,
      has_more: total_bytes > 7,
      chunks: [],
    });
  }
});

it("分页元数据与原生 256 个分片上限一致", () => {
  const chunks = Array.from({ length: 256 }, (_, offset) => ({
    stream: "terminal",
    data_base64: "YQ==",
    offset,
    next_offset: offset + 1,
  }));
  expect(
    parseTerminalPage(
      JSON.stringify({
        ...bytesPage,
        offset: 0,
        next_offset: 256,
        total_bytes: 256,
        has_more: false,
        chunks,
      }),
    ).chunks,
  ).toHaveLength(256);
  const extra = { stream: "terminal", data_base64: "YQ==", offset: 256, next_offset: 257 };
  expect(() =>
    parseTerminalPage(
      JSON.stringify({
        ...bytesPage,
        offset: 0,
        next_offset: 257,
        total_bytes: 257,
        has_more: false,
        chunks: [...chunks, extra],
      }),
    ),
  ).toThrow();
});
