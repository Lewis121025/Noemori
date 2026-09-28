import type { Page } from "playwright-core";

/** 低频文档操作集中在笔记菜单；按真实用户路径打开，不直接调用渲染器内部状态。 */
export async function noteAction(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "笔记操作", exact: true }).click();
  await page.getByRole("button", { name, exact: true }).click();
}

/** 从任一恢复现场进入资料管理，等待保存门禁与空间切换完成。 */
export async function openLibrary(page: Page): Promise<void> {
  await page.locator(".space-button").waitFor();
  const entry = page.getByRole("button", { name: "资料管理", exact: true });
  if (await entry.isVisible()) await entry.click();
  await page.getByRole("region", { name: "资料管理", exact: true }).waitFor();
}
