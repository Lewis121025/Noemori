import type { MediaIo } from "../preview/media";
import { parseWhiteboard, type WhiteboardDocument } from "./model";
import { createWhiteboardPreview } from "./preview";

/**
 * 管理只读白板预览的读取、监听和导航；不会创建编辑会话或写入文件。
 * @param host 独占的预览容器，调用方负责把它挂载到正文或悬停面板。
 * @param path 已唯一解析的库内白板路径。
 * @param io 文件读取与可选监听能力；读取和解析失败显示在当前容器中。
 * @param open 打开原白板的导航动作，保留宿主对来源路径的处理。
 * @returns 幂等的卸载入口，停止监听并丢弃所有迟到结果。
 * @throws 监听能力无法建立时抛出，交由宿主显示失败原因。
 */
export function mountWhiteboardPreview(
  host: HTMLElement,
  path: string,
  io: Pick<MediaIo, "readFile" | "watchFile">,
  open: () => void,
): { destroy: () => void } {
  let live = true;
  let generation = 0;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "whiteboard-embed-open";
  button.setAttribute("aria-label", `打开白板 ${path}`);
  button.style.cssText =
    "display:block;width:100%;padding:0;border:0;background:transparent;cursor:pointer";
  button.addEventListener("click", open);

  function show(board: WhiteboardDocument): void {
    // 更新绘图内容时保留操作入口，后台保存不能移走用户的键盘焦点。
    button.replaceChildren(createWhiteboardPreview(board));
    if (button.parentNode !== host) host.replaceChildren(button);
  }

  async function refresh(): Promise<void> {
    if (!live) return;
    const request = ++generation;
    try {
      const bytes = await io.readFile(path);
      if (live && request === generation)
        show(parseWhiteboard(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    } catch (error) {
      if (live && request === generation)
        host.textContent = `无法读取白板预览：${error instanceof Error ? error.message : String(error)}`;
    }
  }

  host.textContent = "正在预览白板…";
  // 先监听再读取，避免首次读取期间的更新落入订阅空窗。
  const stop = io.watchFile?.(path, () => {
    void refresh();
  });
  void refresh();
  return {
    destroy() {
      if (!live) return;
      live = false;
      stop?.();
    },
  };
}
