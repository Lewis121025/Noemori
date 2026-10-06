import type { WebContents, WebFrameMain } from "electron";

/** 只返回可回收性，不把网页输入内容传出浏览进程。 */
export type WebPageProtection = "discard" | "input" | "active" | "unknown";

const protectionScript = `(() => {
  const fields = Array.from(document.querySelectorAll('input, textarea, select'));
  const input = fields.some((field) => {
    if (field instanceof HTMLTextAreaElement) return field.value !== '';
    if (field instanceof HTMLSelectElement) {
      if (field.multiple) return Array.from(field.options).some((option) => option.selected !== option.defaultSelected);
      const original = Array.from(field.options).findIndex((option) => option.defaultSelected);
      return field.selectedIndex !== (original < 0 ? 0 : original);
    }
    if (!(field instanceof HTMLInputElement)) return false;
    if (['hidden', 'submit', 'reset', 'button', 'image'].includes(field.type)) return false;
    if (field.type === 'file') return (field.files?.length ?? 0) > 0;
    if (field.type === 'checkbox' || field.type === 'radio') return field.checked !== field.defaultChecked;
    if (field.type === 'range' || field.type === 'color') return field.value !== field.defaultValue;
    return field.value !== '';
  });
  // 富文本编辑器没有统一的“已保存”协议，保守保留有内容的编辑区域。
  const editing = Array.from(document.querySelectorAll('[contenteditable="true"], [contenteditable=""]'))
    .some((element) => element.textContent !== '');
  if (input || editing) return 'input';
  if (Array.from(document.querySelectorAll('audio, video')).some((media) => !media.paused && !media.ended)) return 'active';
  return 'discard';
})()`;

async function inspectFrames(
  frames: readonly Pick<WebFrameMain, "executeJavaScript">[],
): Promise<WebPageProtection> {
  if (frames.length === 0) return "unknown";
  let protection: WebPageProtection = "discard";
  for (const frame of frames) {
    const result: unknown = await frame.executeJavaScript(protectionScript);
    if (result === "input") return "input";
    if (result === "active") protection = "active";
    else if (result !== "discard") return "unknown";
  }
  return protection;
}

/**
 * 回收前确认网页没有活动媒体或待保留输入；不能证明安全时保留网页。
 * @param contents 待回收的隔离网页，只读取公开网页状态，不改变输入。
 * @returns 可回收、输入保护、活动保护或无法验证；不抛出网页进程异常。
 */
export async function webPageProtection(
  contents: Pick<WebContents, "isDestroyed" | "isFocused" | "isLoading" | "isCurrentlyAudible"> & {
    mainFrame: { readonly framesInSubtree: readonly Pick<WebFrameMain, "executeJavaScript">[] };
  },
): Promise<WebPageProtection> {
  if (contents.isDestroyed()) return "unknown";
  if (contents.isFocused() || contents.isLoading() || contents.isCurrentlyAudible())
    return "active";
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      inspectFrames(contents.mainFrame.framesInSubtree),
      new Promise<WebPageProtection>((resolve) => {
        timer = setTimeout(() => resolve("unknown"), 1000);
      }),
    ]);
  } catch {
    // 进程切换或脚本执行失败不能成为丢弃用户输入的依据。
    return "unknown";
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
