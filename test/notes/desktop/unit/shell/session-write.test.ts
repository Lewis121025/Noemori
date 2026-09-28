import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  emptySession,
  saveSession,
  loadSession,
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
