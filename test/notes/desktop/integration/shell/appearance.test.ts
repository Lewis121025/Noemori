/** @vitest-environment jsdom */
import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, it, vi } from "vitest";
import AppearanceOptions from "@app/AppearanceOptions.svelte";
import type { AppApi } from "../../../../../modules/notes/packages/desktop/src/shared/api";
let app: ReturnType<typeof mount>;
let target: HTMLDivElement;
const api: Pick<AppApi, "appearanceGet" | "appearanceSet"> = {
  appearanceGet: vi.fn(async () => "system"),
  appearanceSet: vi.fn(async () => {}),
};
async function start() {
  target = document.createElement("div");
  document.body.append(target);
  app = mount(AppearanceOptions, { target, props: { api } });
  await vi.waitFor(() => {
    flushSync();
    expect(target.querySelector('button[aria-pressed="true"]')?.textContent).toContain("深色");
  });
}
afterEach(async () => {
  await unmount(app);
  target.remove();
});
it("恢复外观选择，设置失败时保留原选择并允许重试", async () => {
  vi.mocked(api.appearanceGet).mockResolvedValue("dark");
  await start();
  const dark = target.querySelector<HTMLButtonElement>(
    '.appearance-options button[aria-pressed="true"]',
  )!;
  expect(dark.textContent).toContain("深色");
  vi.mocked(api.appearanceSet).mockRejectedValueOnce(new Error("磁盘只读"));
  const light = [...target.querySelectorAll<HTMLButtonElement>(".appearance-options button")].find(
    (button) => button.textContent?.includes("浅色"),
  )!;
  light.click();
  await vi.waitFor(() => {
    flushSync();
    expect(target.textContent).toContain("外观设置未能保存：磁盘只读");
  });
  expect(dark.getAttribute("aria-pressed")).toBe("true");
  light.click();
  await vi.waitFor(() => {
    flushSync();
    expect(light.getAttribute("aria-pressed")).toBe("true");
  });
  expect(api.appearanceSet).toHaveBeenLastCalledWith("light");
});
