import type { Page } from "playwright-core";

/**
 * 从侧栏顶部选择文件或大纲入口，隐藏时先恢复侧栏。
 * @param page 当前 Electron 窗口。
 * @param name 组件入口的可访问名称。
 * @returns 入口被选中且文档面板完成返回后兑现，异步内容由调用方按目标内容等待。
 * @throws 侧栏或组件不可用时保留 Playwright 定位错误。
 */
export async function sidebarComponent(page: Page, name: string): Promise<void> {
  const sidebar = page.locator(".file-sidebar:not(.right)");
  await sidebar.waitFor({ state: "attached" });
  await page.getByRole("region", { name: "打开资料库", exact: true }).waitFor({ state: "hidden" });
  if (await sidebar.getAttribute("hidden") !== null)
    await page.getByRole("button", { name: "显示或隐藏文件栏", exact: true }).click();
  const label = name === "目录" ? "目录" : "笔记库";
  const panel = sidebar.getByRole("region", { name: label, exact: true });
  if (!(await panel.isVisible()))
    await sidebar
      .getByRole("button", {
        name: label === "目录" ? "文章大纲" : "文件目录",
        exact: true,
      })
      .click();
  await panel.waitFor();
  if (name === "搜索") await sidebar.getByRole("searchbox").focus();
}

/** 顶栏工具始终属于当前文档；从文件系统返回时通过文件入口恢复原文档。 */
export async function documentTools(page: Page): Promise<void> {
  await page.locator(".reading-space").waitFor({ state: "attached" });
  if (!(await page.locator(".reading-space").isVisible())) await sidebarComponent(page, "目录");
  await page.getByRole("group", { name: "当前文档工具", exact: true }).waitFor();
}

/** 打开独立设置窗口；窗口出现后交由调用方选择设置分类。 */
export async function openSettings(page: Page): Promise<void> {
  await page.locator(".file-sidebar:not(.right)").waitFor({ state: "attached" });
  if ((await page.locator(".file-sidebar:not(.right)").getAttribute("hidden")) !== null)
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
  await page.waitForFunction(() => document.querySelector(".pane-column") !== null);
  await sidebarComponent(page, "笔记库");
  await page.getByRole("navigation", { name: "文件列表", exact: true }).waitFor();
}

/** 确认新建表单中的名称与目录；可选名称覆盖建议值，确认成功后等待表单关闭。 */
export async function confirmNewEntry(page: Page, name?: string): Promise<void> {
  const dialog = page.locator(".create-dialog[open]");
  await dialog.waitFor();
  if (name !== undefined) await dialog.getByRole("textbox", { name: "名称", exact: true }).fill(name);
  await dialog.getByRole("button", { name: "创建", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
}

/** 文件管理的新建菜单是唯一可见的创建入口，类型选择后仍需确认名称和位置。 */
export async function newEntry(page: Page, kind: "笔记" | "白板" | "文件夹"): Promise<void> {
  await page.locator(".navigation-heading").getByRole("button", { name: "新建", exact: true }).click();
  await page.locator(".create-menu").getByRole("button", { name: `新建${kind}`, exact: true }).click();
}

/** 从统一目录顶部发起独立 Agent 对话，名称与实际工作目录仍由表单确认。 */
export async function newConversation(page: Page): Promise<void> {
  await openLibrary(page);
  await page.locator(".navigation-heading").getByRole("button", { name: "新建", exact: true }).click();
  await page.locator(".create-menu").getByRole("button", { name: "Agent 对话", exact: true }).click();
}
