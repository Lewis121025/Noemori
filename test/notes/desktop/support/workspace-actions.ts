import type { Page } from "playwright-core";

/**
 * 从固定组件栏选择入口，隐藏时先恢复侧栏。
 * @param page 当前 Electron 窗口。
 * @param name 组件入口的可访问名称。
 * @returns 入口被选中且文档面板完成返回后兑现，异步内容由调用方按目标内容等待。
 * @throws 侧栏或组件不可用时保留 Playwright 定位错误。
 */
export async function sidebarComponent(page: Page, name: string): Promise<void> {
  await page.locator(".file-sidebar").waitFor({ state: "attached" });
  await page.getByRole("region", { name: "打开资料库", exact: true }).waitFor({ state: "hidden" });
  // 退出动画期间仍有画面，但 hidden/inert 已关闭交互；按语义状态恢复侧栏。
  if ((await page.locator(".file-sidebar").getAttribute("hidden")) !== null)
    await page.getByRole("button", { name: "显示或隐藏文件栏", exact: true }).click();
  const entry = page
    .getByRole("toolbar", { name: "组件栏", exact: true })
    .getByRole("button", { name, exact: true });
  const component = await entry.getAttribute("data-component");
  await entry.click();
  await page.waitForFunction(
    (name) =>
      document
        .querySelector(`.component-button[aria-label="${name}"]`)
        ?.getAttribute("aria-pressed") === "true",
    name,
  );
  if (component === "outline")
    await page.locator(".reading-space").waitFor();
}

/** 顶栏工具始终属于当前文档；从文件系统返回时通过文件入口恢复原文档。 */
export async function documentTools(page: Page): Promise<void> {
  await page.locator(".reading-space").waitFor({ state: "attached" });
  if (!(await page.locator(".reading-space").isVisible())) await sidebarComponent(page, "目录");
  await page.getByRole("group", { name: "当前文档工具", exact: true }).waitFor();
}

/** 打开独立设置窗口；窗口出现后交由调用方选择设置分类。 */
export async function openSettings(page: Page): Promise<void> {
  await page.locator(".file-sidebar").waitFor({ state: "attached" });
  if ((await page.locator(".file-sidebar").getAttribute("hidden")) !== null)
    await page.getByRole("button", { name: "显示或隐藏文件栏", exact: true }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("dialog", { name: "设置", exact: true }).waitFor();
}

/** 分栏只有窗口右上角入口，打开文件选择器不改变已有文档。 */
export async function openSplit(page: Page): Promise<void> {
  await page
    .locator(".window-toolbar")
    .getByRole("button", { name: "在另一栏打开…", exact: true })
    .click();
}

/** 低频文档操作集中在笔记菜单；按真实用户路径打开，不直接调用渲染器内部状态。 */
export async function noteAction(page: Page, name: string): Promise<void> {
  await documentTools(page);
  const controls = page.locator(".topbar-document:not([hidden])");
  if (name === "文内查找") {
    await controls.getByRole("button", { name, exact: true }).click();
    return;
  }
  await controls.getByRole("button", { name: "笔记操作", exact: true }).click();
  await controls.getByRole("button", { name, exact: true }).click();
}

/** 从任一恢复现场进入资料管理，等待保存门禁与空间切换完成。 */
export async function openLibrary(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      document.querySelector(".pane-column") !== null &&
      document.querySelector('.window-toolbar [aria-label="显示或隐藏文件栏"]') !== null,
  );
  // 抽屉会让中央页面 inert；应先关闭抽屉，不能把正常的遮罩状态误判为保存未完成。
  if (await page.locator(".library").isVisible()) {
    const scrim = page.getByRole("button", { name: "收起文件栏", exact: true });
    if (await scrim.isVisible())
      await page.getByRole("button", { name: "显示或隐藏文件栏", exact: true }).click();
    return;
  }
  await sidebarComponent(page, "文件系统");
  await page.getByRole("region", { name: "文件系统", exact: true }).waitFor();
}
