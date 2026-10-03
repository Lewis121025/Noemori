import { describe, expect, it } from "vitest";
import {
  EXPORT_FORMATS,
  EXPORT_LIMITS,
  parseExportId,
  parseExportProgress,
  parseExportRequest,
  parseExportResult,
  parseExportPlan,
  parseExportIssues,
} from "@reader/shared/export";

describe("导出契约", () => {
  it("源文件数量在去重枚举后计数，重复选择不能提前触发一万文件上限", () => {
    expect(
      parseExportRequest({
        root: "/vault",
        format: "archive",
        scope: {
          kind: "selection",
          paths: Array.from({ length: 10_001 }, () => "a.md"),
        },
      }).scope,
    ).toEqual({ kind: "selection", paths: ["a.md"] });
  });
  it("所有资源预算与已确认交付契约一致", () => {
    expect(EXPORT_LIMITS).toEqual({
      files: 10_000,
      bytes: 5_368_709_120,
      memoryBytes: 2_147_483_648,
      resourceBytes: 67_108_864,
      imagePixels: 33_554_432,
      imageEdge: 16_384,
      downloadMs: 30_000,
      downloadConcurrency: 4,
      redirects: 5,
      renderMs: 180_000,
      embedDepth: 3,
    });
    expect([...EXPORT_FORMATS]).toEqual(["pdf", "docx", "markdown", "archive", "png", "svg"]);
  });
  it("响应式选择在 IPC 边界转换为可复制的普通对象", () => {
    const scope = new Proxy({ kind: "selection", paths: new Proxy(["甲.md"], {}) }, {});
    expect(() => structuredClone(scope)).toThrow();
    expect(structuredClone(parseExportRequest({ root: "/vault", format: "pdf", scope }))).toEqual({
      root: "/vault",
      format: "pdf",
      scope: { kind: "selection", paths: ["甲.md"] },
    });
  });
  it.each(EXPORT_FORMATS)("所有格式使用相同的选择契约：%s", (format) => {
    expect(
      parseExportRequest({
        root: "/vault",
        format,
        scope: { kind: "selection", paths: ["中文/甲.md", "中文/甲.md"] },
      }).scope,
    ).toEqual({ kind: "selection", paths: ["中文/甲.md"] });
    expect(parseExportRequest({ root: "/vault", format, scope: { kind: "vault" } }).scope).toEqual({
      kind: "vault",
    });
  });
  it.each([
    null,
    {},
    { root: "", format: "pdf", scope: { kind: "vault" } },
    { root: "/vault", format: "html", scope: { kind: "vault" } },
    ...[[], ["../escape"], ["/absolute"], ["a\0b"], ["good.md", "../bad"]].map((paths) => ({
      root: "/vault",
      format: "pdf",
      scope: { kind: "selection", paths },
    })),
  ])("拒绝整项非法请求", (value) => expect(() => parseExportRequest(value)).toThrow());
  it("接受文件数量边界", () => {
    expect(
      parseExportRequest({
        root: "/vault",
        format: "pdf",
        scope: {
          kind: "selection",
          paths: Array.from({ length: EXPORT_LIMITS.files }, (_, i) => `${i}.md`),
        },
      }).scope.kind,
    ).toBe("selection");
  });
  it("失败与成功必须具有一致的诊断", () => {
    const issue = { path: "x.md", severity: "error", message: "公式错误", line: 2 };
    expect(parseExportResult({ status: "failed", issues: [issue] }).status).toBe("failed");
    expect(() => parseExportResult({ status: "failed", issues: [] })).toThrow();
    expect(() =>
      parseExportResult({ status: "saved", path: "/out", warning: null, issues: [issue] }),
    ).toThrow();
    expect(
      parseExportResult({ status: "saved", path: "/out", warning: "清理失败", issues: [] }).status,
    ).toBe("saved");
    expect(parseExportResult({ status: "cancelled" })).toEqual({ status: "cancelled" });
  });
  it("校验迟到消息、非法任务编号及进度", () => {
    expect(parseExportId("task-1")).toBe("task-1");
    expect(() => parseExportId("../task")).toThrow();
    expect(
      parseExportProgress({ phase: "checking", completed: 0, total: null, path: null }).total,
    ).toBeNull();
    for (const [phase, completed, total] of [
      ["unknown", 0, 1],
      ["checking", -1, 1],
      ["checking", 2, 1],
      ["checking", 0.5, 1],
    ])
      expect(() => parseExportProgress({ phase, completed, total, path: null })).toThrow();
  });
  it("互斥的范围字段不能被忽略后意外扩大为整库", () => {
    expect(() =>
      parseExportRequest({
        root: "/vault",
        format: "pdf",
        scope: { kind: "vault", paths: ["a.md"] },
      }),
    ).toThrow();
  });
  it("预检清单必须有界、唯一且与结构化诊断一致", () => {
    const plan = {
      files: ["a.md", "https://example.test/image.png"],
      bytes: EXPORT_LIMITS.bytes,
      issues: [{ path: "a.md", line: 1, severity: "warning", message: "普通链接" }],
    };
    expect(parseExportPlan(plan)).toEqual(plan);
    for (const value of [
      null,
      {},
      { ...plan, files: [1] },
      { ...plan, files: ["a.md", "a.md"] },
      { ...plan, files: [""] },
      { ...plan, files: ["a\0b"] },
      { ...plan, files: Array(EXPORT_LIMITS.files + 1).fill("a.md") },
      { ...plan, bytes: -1 },
      { ...plan, bytes: 0.5 },
      { ...plan, bytes: EXPORT_LIMITS.bytes + 1 },
      { ...plan, issues: null },
    ])
      expect(() => parseExportPlan(value)).toThrow();
    for (const issues of [
      null,
      [null],
      [{}],
      [{ path: 1, message: "error", severity: "error" }],
      [{ path: "a", message: "", severity: "error" }],
      [{ path: "a", message: "error", severity: "info" }],
      ...[0, -1, 0.5, "1", null].map((line) => [
        { path: "a", message: "error", severity: "error", line },
      ]),
    ])
      expect(() => parseExportIssues(issues)).toThrow();
    for (const value of [
      null,
      {},
      { status: "failed" },
      { status: "saved", issues: [], path: "", warning: null },
      { status: "saved", issues: [], path: "/out", warning: 0 },
    ])
      expect(() => parseExportResult(value)).toThrow();
    for (const value of [
      null,
      {},
      { phase: "checking", completed: Number.MAX_SAFE_INTEGER + 1, total: null, path: null },
      { phase: "checking", completed: 0, total: NaN, path: null },
      { phase: "checking", completed: 0, total: 1, path: 1 },
    ])
      expect(() => parseExportProgress(value)).toThrow();
  });
});
