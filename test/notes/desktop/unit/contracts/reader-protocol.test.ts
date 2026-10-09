import { expect, it } from "vitest";
import {
  parseEmptyReply,
  parseEntryOutcome,
  parseHeadingRecords,
  parseLinkKindArgument,
  parseLinkRecords,
  parseLinkTarget,
  parseMentions,
  parsePaneLayoutMessage,
  parseSavedCopy,
  parseSearchHits,
  parseSearchQueryArgument,
  parseVaultEntries,
  parseVaultRestore,
  parseVaultOpen,
  parseWriteRequest,
  parseWriteResult,
} from "@reader/shared/reader-protocol";

const bytes = new TextEncoder().encode("中文 👩‍💻\r\n");

it("三页布局可穿过 IPC，未知空间不能污染会话", () => {
  for (const space of ["writing", "library", "connections"]) {
    const layout = { filesCollapsed: false, leftWidth: 232, space };
    expect(parsePaneLayoutMessage(layout)).toEqual(layout);
  }
  expect(() =>
    parsePaneLayoutMessage({ filesCollapsed: false, leftWidth: 232, space: "unknown" }),
  ).toThrow("文件栏布局参数无效");
});

it("空文件与不存在的磁盘基准有效，但缺失基准和伪字节不能进入写盘", () => {
  const empty = new Uint8Array();
  expect(parseWriteRequest("空文件.md", empty, null)).toEqual({
    rel: "空文件.md",
    bytes: empty,
    expected: null,
  });
  expect(parseWriteRequest("笔记.md", bytes, bytes).expected).toBe(bytes);
  for (const invalid of [undefined, [], {}, "字节", 10]) {
    expect(() => parseWriteRequest("笔记.md", invalid, bytes)).toThrow();
    expect(() => parseWriteRequest("笔记.md", bytes, invalid)).toThrow();
  }
  for (const invalid of [undefined, false, "", "路径\0.md"])
    expect(() => parseVaultOpen({ root: invalid, entries: [] })).toThrow();
  expect(parseVaultOpen(null)).toBeNull();
});

it("保存确认严格区分提交、冲突和未知响应，警告不会丢失", () => {
  expect(parseWriteResult({ status: "saved", warning: "索引稍后重试" })).toEqual({
    status: "saved",
    warning: "索引稍后重试",
  });
  expect(parseWriteResult({ status: "conflict", disk: bytes })).toEqual({
    status: "conflict",
    disk: bytes,
  });
  expect(parseWriteResult({ status: "conflict", disk: null })).toEqual({
    status: "conflict",
    disk: null,
  });
  for (const invalid of [
    null,
    true,
    {},
    { status: "saved" },
    { status: "saved", warning: false },
    { status: "conflict" },
    { status: "conflict", disk: [] },
  ])
    expect(() => parseWriteResult(invalid)).toThrow("无法确认保存结果");
  expect(parseSavedCopy({ path: "笔记 (副本).md", warning: null })).toEqual({
    path: "笔记 (副本).md",
    warning: null,
  });
  expect(() => parseSavedCopy({ path: "", warning: null })).toThrow("无法确认副本保存结果");
  for (const path of ["../副本.md", "/库外/副本.md", "目录/../副本.md"])
    expect(() => parseSavedCopy({ path, warning: null })).toThrow("无法确认副本保存结果");
  expect(() => parseEntryOutcome({ warning: {} })).toThrow("无法确认文件操作结果");
  expect(() => parseEmptyReply({ status: "failed" })).toThrow("未收到有效的操作确认");
  expect(parseEmptyReply(undefined)).toBeUndefined();
});

it("库与目录快照要求完整结构，不能把错误响应显示为空库或恢复文件夹", () => {
  const documents = {
    panes: [{ currentPath: null, history: { back: [], forward: [] } }],
    active: 0,
    split: false,
  };
  expect(parseVaultRestore({ root: "/笔记", documents, entries: [] })).toEqual({
    root: "/笔记",
    entries: [],
    documents,
    viewModes: {},
    recentFiles: [],
    fileTree: null,
  });
  // 阅读栈与源码视图记忆随恢复响应归一化；损坏条目丢弃而不是拒绝整个恢复。
  expect(
    parseVaultRestore({
      root: "/笔记",
      entries: [],
      documents: {
        panes: [
          {
            currentPath: null,
            history: { back: [{ path: "a.md", anchor: "小节" }, { path: 5 }], forward: "junk" },
          },
        ],
        active: 0,
        split: false,
      },
      viewModes: { "b.md": "reading", "c.md": "source", "d.md": "wysiwyg", "": "source" },
      recentFiles: ["c.md", 3, "c.md", "d.md"],
    }),
  ).toMatchObject({
    documents: {
      panes: [{ history: { back: [{ path: "a.md", anchor: "小节" }], forward: [] } }],
    },
    viewModes: { "c.md": "source" },
    recentFiles: ["c.md", "d.md"],
  });
  expect(parseVaultRestore(null)).toBeNull();
  expect(parseVaultOpen({ root: "/笔记", entries: [] })).toEqual({ root: "/笔记", entries: [] });
  expect(() => parseVaultOpen({ root: "/笔记" })).toThrow();
  expect(() => parseVaultRestore({ root: "/笔记", documents })).toThrow();
  expect(() => parseVaultRestore({ root: "/笔记" })).toThrow();
  const entries = [
    { path: "目录", kind: "directory" },
    { path: "目录/草稿.md", kind: "file", recoveryOnly: true },
  ];
  expect(parseVaultEntries(entries)).toEqual(entries);
  for (const invalid of [
    [{ path: "目录", kind: "directory", recoveryOnly: true }],
    [{ path: "笔记.md", kind: "unknown" }],
    [{ path: false, kind: "file" }],
  ])
    expect(() => parseVaultEntries(invalid)).toThrow();
  expect(
    parsePaneLayoutMessage({ filesCollapsed: false, leftWidth: 232, vaultRoot: "/注入" }),
  ).toEqual({ filesCollapsed: false, leftWidth: 232 });
  for (const invalid of [
    {},
    { filesCollapsed: false, leftWidth: Infinity },
    { filesCollapsed: "false", leftWidth: 232 },
  ])
    expect(() => parsePaneLayoutMessage(invalid)).toThrow();
});

it("索引只接受明确语法及有效字节范围，错误记录不能被当作另一种链接", () => {
  const link = {
    fromPath: "来源.md",
    toRaw: "目标",
    toPath: null,
    kind: "wiki",
    resolution: "dead",
    startByte: 4,
    endByte: 12,
  };
  expect(parseLinkRecords([link])).toEqual([link]);
  expect(parseLinkKindArgument("wiki")).toBe("wiki");
  expect(parseLinkKindArgument("md")).toBe("md");
  expect(() => parseLinkKindArgument("unknown")).toThrow();
  for (const change of [
    { kind: "unknown" },
    { startByte: -1 },
    { endByte: 3 },
    { startByte: 1.5 },
    { endByte: Number.MAX_SAFE_INTEGER + 1 },
    { toPath: false },
    { resolution: "unknown" },
    { resolution: undefined },
  ])
    expect(() => parseLinkRecords([{ ...link, ...change }])).toThrow();
});

it("提及种类、分组和语法必须一致，保留当前纳秒时间字段的数值范围", () => {
  const mention = {
    fromPath: "来源.md",
    fromTitle: "来源",
    mtime: 1_790_000_000_000_000_000,
    startByte: 0,
    endByte: 6,
    snippet: "目标",
    toRaw: "目标",
    kind: "linked",
    linkKind: "wiki",
  };
  const result = {
    linked: [mention],
    unlinked: [{ ...mention, kind: "unlinked", linkKind: null }],
  };
  expect(parseMentions(result)).toEqual(result);
  for (const change of [
    { kind: "unknown" },
    { linkKind: null },
    { mtime: Infinity },
    { endByte: -1 },
  ])
    expect(() => parseMentions({ linked: [{ ...mention, ...change }], unlinked: [] })).toThrow();
  expect(() => parseMentions({ linked: [], unlinked: [mention] })).toThrow();
});

it("检索表达式逐节点校验，超界上限收敛到内核对 i32 的表示范围", () => {
  const expr = {
    kind: "or",
    children: [
      {
        kind: "and",
        children: [
          { kind: "term", value: "全文" },
          { kind: "regex", value: "a+" },
        ],
      },
      { kind: "section", child: { kind: "path", value: "notes/" } },
      { kind: "attr", key: "status", value: null },
    ],
  };
  expect(parseSearchQueryArgument({ expr, limit: 1e9, extra: true })).toEqual({ expr, limit: 500 });
  // 多余字段不透传。
  expect(
    parseSearchQueryArgument({ expr: { kind: "file", value: "x", junk: 1 }, limit: 1 }).expr,
  ).toEqual({ kind: "file", value: "x" });
  const wide = {
    kind: "and",
    children: Array.from({ length: 300 }, () => ({ kind: "term", value: "x" })),
  };
  for (const invalid of [
    undefined,
    "原始查询串",
    { expr: { kind: "term", value: 1 }, limit: 1 },
    { expr: { kind: "not" }, limit: 1 },
    { expr: { kind: "attr", key: 1, value: null }, limit: 1 },
    { expr: { kind: "attr", key: "k", value: 5 }, limit: 1 },
    { expr: { kind: "and", children: [] }, limit: "1" },
    { expr: { kind: "and", children: [] }, limit: Infinity },
    { expr: wide, limit: 1 },
  ])
    expect(() => parseSearchQueryArgument(invalid)).toThrow();
});

it("检索命中与标题记录逐项校验，损坏数据整体拒绝", () => {
  const hit = {
    path: "a.md",
    title: "A",
    snippet: "正文",
    contentHash: "a".repeat(64),
    matches: [{ snippet: "命中", location: { startByte: 0, endByte: 3, line: 1 } }],
    matchCount: 1,
    matchesCursor: null,
  };
  expect(parseSearchHits([hit])).toEqual([hit]);
  for (const location of [
    { startByte: -1, endByte: 3, line: 1 },
    { startByte: 3, endByte: 3, line: 1 },
    { startByte: 0, endByte: 3, line: 0 },
    { startByte: 0.5, endByte: 3, line: 1 },
  ]) {
    expect(() => parseSearchHits([{ ...hit, matches: [{ snippet: "命中", location }] }])).toThrow(
      "位置",
    );
  }
  expect(() => parseSearchHits([{ ...hit, contentHash: "过期" }])).toThrow("检索命中");
  expect(
    parseSearchHits([
      {
        path: "a.md",
        title: "A",
        contentHash: "a".repeat(64),
        matches: [],
        snippet: "前\u{1}命中\u{2}后",
        matchCount: 0,
        matchesCursor: null,
      },
    ]),
  ).toEqual([
    {
      path: "a.md",
      title: "A",
      contentHash: "a".repeat(64),
      matches: [],
      snippet: "前\u{1}命中\u{2}后",
      matchCount: 0,
      matchesCursor: null,
    },
  ]);
  for (const invalid of [
    {},
    {
      path: "../逃逸.md",
      title: "A",
      contentHash: "a".repeat(64),
      matches: [],
      snippet: "",
      matchCount: 0,
      matchesCursor: null,
    },
    {
      path: "a.md",
      title: 1,
      contentHash: "a".repeat(64),
      matches: [],
      snippet: "",
      matchCount: 0,
      matchesCursor: null,
    },
    {
      path: "a.md",
      title: "A",
      contentHash: "a".repeat(64),
      matches: [],
      snippet: null,
      matchCount: 0,
      matchesCursor: null,
    },
  ])
    expect(() => parseSearchHits([invalid])).toThrow("检索命中");
  expect(() => parseSearchHits({})).toThrow("检索响应");

  const heading = { path: "a.md", level: 2, text: "标题", startByte: 0, endByte: 9 };
  expect(parseHeadingRecords([heading])).toEqual([heading]);
  for (const change of [
    { level: 0 },
    { level: 7 },
    { level: 2.5 },
    { text: 1 },
    { startByte: -1 },
    { endByte: -1 },
    { startByte: 9, endByte: 0 },
  ])
    expect(() => parseHeadingRecords([{ ...heading, ...change }])).toThrow("标题索引");
  expect(() => parseHeadingRecords({})).toThrow("标题索引响应");
});

it("链接解析响应按状态判别，损坏响应不退化成死链", () => {
  expect(parseLinkTarget({ status: "resolved", path: "a.md", anchor: null })).toEqual({
    status: "resolved",
    path: "a.md",
    anchor: null,
  });
  // 缺失与空锚点统一归一化为 null。
  expect(parseLinkTarget({ status: "resolved", path: "a.md" })).toEqual({
    status: "resolved",
    path: "a.md",
    anchor: null,
  });
  expect(parseLinkTarget({ status: "resolved", path: "a.md", anchor: "" })).toEqual({
    status: "resolved",
    path: "a.md",
    anchor: null,
  });
  expect(
    parseLinkTarget({ status: "ambiguous", candidates: ["a/x.md", "b/x.md"], anchor: "小节" }),
  ).toEqual({ status: "ambiguous", candidates: ["a/x.md", "b/x.md"], anchor: "小节" });
  expect(parseLinkTarget({ status: "dead" })).toEqual({ status: "dead" });
  for (const invalid of [
    null,
    "a.md",
    { status: "unknown" },
    { status: "resolved" },
    { status: "resolved", path: "../逃逸.md", anchor: null },
    { status: "resolved", path: "a.md", anchor: 5 },
    { status: "ambiguous", candidates: [], anchor: null },
    { status: "ambiguous", candidates: ["../逃逸.md"], anchor: null },
    { status: "ambiguous", anchor: null },
  ])
    expect(() => parseLinkTarget(invalid)).toThrow("链接解析响应无效");
});

it("布局 IPC 丢弃已废弃的交互模式字段", () => {
  const layout = { filesCollapsed: false, leftWidth: 232 };
  for (const mode of ["reading", "editing", "unknown"])
    expect(parsePaneLayoutMessage({ ...layout, mode })).toEqual(layout);
});

it("工作台布局 IPC 保留合法偏好并拒绝非法状态", () => {
  const layout = {
    filesCollapsed: false,
    leftWidth: 232,
    destination: "library",
    sidebarView: "search",
    searchQuery: "笔记",
  };
  expect(parsePaneLayoutMessage(layout)).toEqual(layout);
  for (const field of [
    { destination: "canvas" },
    { destination: "graph" },
    { sidebarView: "tags" },
    { searchQuery: 5 },
  ])
    expect(() => parsePaneLayoutMessage({ ...layout, ...field })).toThrow("文件栏布局参数无效");
});


it("目录修改时间使用毫秒，拒绝非法元数据而不是伪造日期", () => {
  const entry = { path: "a.md", kind: "file", modifiedAt: 1700000001234 };
  expect(parseVaultEntries([entry])).toEqual([entry]);
  for (const modifiedAt of [-1, NaN, Infinity, "昨天"])
    expect(() => parseVaultEntries([{ ...entry, modifiedAt }])).toThrow();
});

it("统一工作台布局保留笔记库导航与右栏宽度，非法右栏参数不能静默丢弃", () => {
  const layout = { filesCollapsed: false, leftWidth: 232, sidebarView: "files", rightWidth: 420 };
  expect(parsePaneLayoutMessage(layout)).toEqual(layout);
  for (const rightWidth of [319, 641, Infinity, "420", null])
    expect(() => parsePaneLayoutMessage({ ...layout, rightWidth })).toThrow("文件栏布局参数无效");
});
