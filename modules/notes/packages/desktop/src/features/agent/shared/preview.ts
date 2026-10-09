import type { BrowserHumanInput, UiPreviewTarget, UiPreviewFrame } from "./api";
import { record } from "./values";

function text(item: Record<string, unknown>, key: string, limit: number): string {
  const value = item[key];
  if (typeof value !== "string" || !value.length || value.length > limit)
    throw new Error("预览参数无效");
  return value;
}

/** 从 IPC 输入建立独立目标值；未知后端或超限身份在访问会话前拒绝。 */
export function parsePreviewTarget(value: unknown): UiPreviewTarget {
  const item = record(value);
  const backend = item["backend"];
  if (backend === "managed" || backend === "chrome" || backend === "edge")
    return { backend, page: text(item, "page", 128) };
  if (item["backend"] === "computer")
    return { backend: "computer", app: text(item, "app", 256), window: text(item, "window", 128) };
  throw new Error("预览后端无效");
}

/** 校验原生预览回执；不接受任意 URL 或缺失的控制状态，损坏回执抛出错误。 */
export function parsePreviewFrame(value: unknown): UiPreviewFrame {
  const item = record(value);
  const image = item["image"];
  if (
    image !== null &&
    (typeof image !== "string" ||
      image.length > 7 * 1024 * 1024 ||
      !/^data:image\/(jpeg|png);base64,/.test(image))
  )
    throw new Error("预览图像无效");
  return { image, inputToken: item["inputToken"] === null ? null : text(item, "inputToken", 128) };
}

/** 校验浮窗输入；坐标和文本超限、未知操作均抛出错误，不接收任意执行命令。 */
export function parseBrowserHumanInput(value: unknown): BrowserHumanInput {
  const item = record(value);
  const type = item["type"];
  if (type === "dialog") {
    if (typeof item["accept"] !== "boolean") throw new Error("对话框回应无效");
    const prompt = item["text"];
    if (prompt !== undefined && (typeof prompt !== "string" || prompt.length > 16384))
      throw new Error("对话框输入无效");
    return { type, accept: item["accept"], ...(prompt === undefined ? {} : { text: prompt }) };
  }
  if (type === "files") {
    const paths = item["paths"];
    if (!Array.isArray(paths) || paths.length > 50) throw new Error("文件选择无效");
    return { type, paths: paths.map((path: unknown) => text({ path }, "path", 8192)) };
  }
  if (type === "key") return { type, key: text(item, "key", 100) };
  if (type === "text") return { type, text: text(item, "text", 16384) };
  if (type === "pointer" || type === "scroll") {
    const x = item["x"],
      y = item["y"];
    const min = type === "pointer" ? 0 : -10000;
    const max = type === "pointer" ? 4096 : 10000;
    if (
      typeof x !== "number" ||
      typeof y !== "number" ||
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      x < min ||
      y < min ||
      x > max ||
      y > max
    )
      throw new Error("预览坐标无效");
    return { type, x, y };
  }
  throw new Error("预览输入类型无效");
}

/** 浮窗拖动后限制在可见区域；小窗口仍保留关闭入口，无异常。 */
export function previewPosition(
  x: number,
  y: number,
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
): { x: number; y: number } {
  return {
    x: Math.max(8, Math.min(x, viewportWidth - width - 8)),
    y: Math.max(8, Math.min(y, viewportHeight - height - 8)),
  };
}
