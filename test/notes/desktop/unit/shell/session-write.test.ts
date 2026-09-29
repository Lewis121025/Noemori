import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  emptySession,
  saveSession,
  loadSession,
  patchSession,
} from "../../../../../modules/notes/packages/desktop/src/main/session";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: vi.fn(actual.writeFileSync),
    fsyncSync: vi.fn(actual.fsyncSync),
    renameSync: vi.fn(actual.renameSync),
    closeSync: vi.fn(actual.closeSync),
  };
});
afterEach(() => vi.restoreAllMocks());

it.each(["missing", "corrupt"])("%s 会话提交默认值仍须创建有效文件", (state) => {
  const directory = fs.mkdtempSync(join(tmpdir(), "nous-session-default-"));
  const file = join(directory, "session.json");
  try {
    if (state === "corrupt") fs.writeFileSync(file, "{invalid");
    patchSession(file, {});
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(emptySession);
    expect(fs.readdirSync(directory)).toEqual(["session.json"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it("重复提交相同会话不写盘；外部改变后仍核对磁盘，失败提交可以重试", () => {
  const directory = fs.mkdtempSync(join(tmpdir(), "nous-session-resource-"));
  const file = join(directory, "session.json");
  try {
    patchSession(file, { appearance: "dark" });
    vi.mocked(fs.writeFileSync).mockClear();
    vi.mocked(fs.fsyncSync).mockClear();
    vi.mocked(fs.renameSync).mockClear();
    for (let index = 0; index < 50; index++) patchSession(file, { appearance: "dark" });
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(fs.fsyncSync).not.toHaveBeenCalled();
    expect(fs.renameSync).not.toHaveBeenCalled();

    saveSession(file, { ...emptySession, appearance: "light" });
    patchSession(file, { appearance: "dark" });
    expect(loadSession(file).appearance).toBe("dark");
    vi.mocked(fs.renameSync).mockImplementationOnce(() => {
      throw new Error("提交失败");
    });
    expect(() => patchSession(file, { appearance: "light" })).toThrow("提交失败");
    expect(loadSession(file).appearance).toBe("dark");
    patchSession(file, { appearance: "light" });
    expect(loadSession(file).appearance).toBe("light");
    expect(fs.readdirSync(directory)).toEqual(["session.json"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it.each(["write", "sync", "close", "rename"])(
  "会话 %s 失败保留完整旧文件并清理临时文件",
  async (phase) => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    const directory = fs.mkdtempSync(join(tmpdir(), "nous-session-commit-"));
    const file = join(directory, "session.json");
    const original = JSON.stringify({ ...emptySession, appearance: "dark" });
    actual.writeFileSync(file, original);
    const fail = () => {
      throw new Error(`failed ${phase}`);
    };
    if (phase === "write")
      vi.mocked(fs.writeFileSync).mockImplementationOnce((target) => {
        actual.writeFileSync(target, '{"reader":');
        fail();
      });
    if (phase === "sync") vi.mocked(fs.fsyncSync).mockImplementationOnce(fail);
    if (phase === "close")
      vi.mocked(fs.closeSync).mockImplementationOnce((fd) => {
        actual.closeSync(fd);
        fail();
      });
    if (phase === "rename") vi.mocked(fs.renameSync).mockImplementationOnce(fail);
    try {
      expect(() => saveSession(file, { ...emptySession, appearance: "light" })).toThrow(
        `failed ${phase}`,
      );
      expect(fs.readFileSync(file, "utf8")).toBe(original);
      expect(fs.readdirSync(directory)).toEqual(["session.json"]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);

it("只有原子替换完成才发布新会话，替换后没有会被误报为失败的文件操作", () => {
  const directory = fs.mkdtempSync(join(tmpdir(), "nous-session-success-"));
  const file = join(directory, "session.json");
  try {
    saveSession(file, { ...emptySession, appearance: "dark" });
    expect(loadSession(file).appearance).toBe("dark");
    const committedAt = vi.mocked(fs.renameSync).mock.invocationCallOrder.at(-1)!;
    expect(vi.mocked(fs.fsyncSync).mock.invocationCallOrder.at(-1)).toBeLessThan(committedAt);
    expect(vi.mocked(fs.closeSync).mock.invocationCallOrder.at(-1)).toBeLessThan(committedAt);
    expect(fs.readdirSync(directory)).toEqual(["session.json"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
