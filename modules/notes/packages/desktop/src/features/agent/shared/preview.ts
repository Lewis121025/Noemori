import type { BrowserHumanInput, UiPreviewTarget, UiPreviewFrame } from "./api";
import { record } from "./values";

function text(item: Record<string, unknown>, key: string, limit: number): string {
  const value = item[key];
  if (typeof value !== "string" || !value.length || value.length > limit)
    throw new Error("预览参数无效");
  return value;
}

/** 将 contain 图片中的点击映射到原始像素；留白和无效尺寸返回 null，不向后端派发。 */
export function previewImagePoint(
  bounds: { left: number; top: number; width: number; height: number },
  width: number,
  height: number,
  x: number,
  y: number,
): { x: number; y: number } | null {
  if (
    ![bounds.left, bounds.top, bounds.width, bounds.height, width, height, x, y].every(
      Number.isFinite,
    ) ||
    width <= 0 ||
    height <= 0 ||
    bounds.width <= 0 ||
    bounds.height <= 0
  )
    return null;
  const scale = Math.min(bounds.width / width, bounds.height / height);
  const left = bounds.left + (bounds.width - width * scale) / 2;
  const top = bounds.top + (bounds.height - height * scale) / 2;
  const point = { x: Math.floor((x - left) / scale), y: Math.floor((y - top) / scale) };
  return point.x < 0 || point.y < 0 || point.x >= width || point.y >= height ? null : point;
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
  function coordinate(key: string, min = 0, max = 4096): number {
    const value = item[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)
      throw new Error("预览坐标无效");
    return value;
  }
  if (type === "drag")
    return {
      type,
      from_x: coordinate("from_x"),
      from_y: coordinate("from_y"),
      to_x: coordinate("to_x"),
      to_y: coordinate("to_y"),
    };
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
    const min = type === "pointer" ? 0 : -10000;
    const max = type === "pointer" ? 4096 : 10000;
    const x = coordinate("x", min, max),
      y = coordinate("y", min, max);
    if (type === "scroll")
      return {
        type,
        x,
        y,
        ...(item["at_x"] === undefined && item["at_y"] === undefined
          ? {}
          : { at_x: coordinate("at_x"), at_y: coordinate("at_y") }),
      };
    const button = item["button"];
    if (button !== undefined && button !== "left" && button !== "right" && button !== "middle")
      throw new Error("预览鼠标按钮无效");
    const clicks = item["clicks"];
    if (
      clicks !== undefined &&
      (typeof clicks !== "number" || !Number.isSafeInteger(clicks) || clicks < 1 || clicks > 3)
    )
      throw new Error("预览点击次数无效");
    return {
      type,
      x,
      y,
      ...(button === undefined ? {} : { button }),
      ...(clicks === undefined ? {} : { clicks }),
    };
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
