import type { Browser, BrowserContext } from "playwright-core";

/**
 * 在浏览器收到下载字节时执行预算，避免先完整落盘再发现文件超限。
 * @param browser 宿主拥有的 Chromium 连接，必须支持浏览器级 CDP 下载控制。
 * @param context 当前会话独占的浏览器上下文。
 * @param directory 与 connectOverCDP.artifactsDir 相同的宿主私有目录。
 * @param maximum 单个下载的最大字节数。
 * @returns 解除事件订阅并等待已派发取消请求的入口。
 * @throws 浏览器不支持下载控制或初始化失败时抛出错误，不能默默失去预算约束。
 */
export async function limitDownloads(
  browser: Browser,
  context: BrowserContext,
  directory: string,
  maximum: number,
): Promise<() => Promise<void>> {
  const probe = await context.newPage();
  const target = await context.newCDPSession(probe);
  const { targetInfo } = await target.send("Target.getTargetInfo");
  await target.detach();
  await probe.close();
  const control = await browser.newBrowserCDPSession();
  const browserContextId = targetInfo.browserContextId;
  if (!browserContextId) {
    await control.detach();
    throw new Error("下载预算需要独立浏览器上下文");
  }
  await control.send("Browser.setDownloadBehavior", {
    behavior: "allowAndName",
    browserContextId,
    downloadPath: directory,
    eventsEnabled: true,
  });
  const cancelled = new Set<string>();
  const pending = new Set<Promise<void>>();
  let failure: unknown;
  const listener = (event: { guid: string; receivedBytes: number; state: string }) => {
    if (event.receivedBytes <= maximum || cancelled.has(event.guid) || event.state !== "inProgress")
      return;
    cancelled.add(event.guid);
    const task = control
      .send("Browser.cancelDownload", { guid: event.guid, browserContextId })
      .then(() => undefined)
      .catch(async (error: unknown) => {
        failure = error;
        await context.close();
      })
      .finally(() => pending.delete(task));
    pending.add(task);
  };
  control.on("Browser.downloadProgress", listener);
  return async () => {
    control.off("Browser.downloadProgress", listener);
    await Promise.all(pending);
    await control.detach();
    if (failure) throw failure;
  };
}
