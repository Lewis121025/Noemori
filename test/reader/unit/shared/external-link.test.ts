import { beforeEach, expect, it, vi } from "vitest";
import { externalUrl } from "@reader/shared/link-target";
import { registerReaderIpc } from "@reader/main/ipc";

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  openExternal: vi.fn(async () => {}),
}));
vi.mock("electron", () => ({
  dialog: {},
  shell: { openExternal: electron.openExternal },
  ipcMain: {
    handle: (name: string, callback: (...args: unknown[]) => unknown) =>
      electron.handlers.set(name, callback),
  },
}));
beforeEach(() => {
  electron.handlers.clear();
  electron.openExternal.mockClear();
});

it("主进程独立校验协议，只把合法链接交给系统应用", async () => {
  registerReaderIpc(() => null, { call: vi.fn() });
  const open = electron.handlers.get("reader.links.openExternal")!;
  await open(null, "https://example.com/path?q=1#section");
  expect(electron.openExternal).toHaveBeenCalledWith("https://example.com/path?q=1#section");
  for (const value of [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,test",
    "obsidian://open",
    {},
    "https:\n//example.com",
  ])
    expect(() => open(null, value)).toThrow();
  expect(electron.openExternal).toHaveBeenCalledTimes(1);
});

it("支持邮件和中文 URL，打开失败沿原 Promise 返回", async () => {
  expect(externalUrl("mailto:reader@example.com")).toBe("mailto:reader@example.com");
  expect(externalUrl("https://example.com/中文")).toContain("%E4%B8%AD");
  registerReaderIpc(() => null, { call: vi.fn() });
  electron.openExternal.mockRejectedValueOnce(new Error("系统应用不可用"));
  await expect(
    electron.handlers.get("reader.links.openExternal")!(null, "https://example.com"),
  ).rejects.toThrow("系统应用不可用");
});
