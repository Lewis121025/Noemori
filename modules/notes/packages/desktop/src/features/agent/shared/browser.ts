import { record, text } from "./values";

/** 工具栏只允许导航与标签页动作，不能执行脚本或改变模型权限。 */
export type BrowserNavigation =
  | { action: "open"; url: string }
  | { action: "navigate"; page: string; url: string }
  | { action: "back" | "forward" | "reload" | "close"; page: string };
/** 真实网页的位置来自可信主框架，控制者不随页面忙闲状态改变。 */
export type BrowserViewPlacement = {
  page: string;
  human: boolean;
  bounds: { x: number; y: number; width: number; height: number };
};
/** 下载只暴露登记身份与进度，保存由主进程让用户选择目标。 */
export type BrowserDownload = {
  id: string;
  name: string;
  bytes: number;
  status: "running" | "completed" | "failed";
  error: string | null;
};

/**
 * 补全域名与本地地址，搜索词交给搜索页。
 * @param value 用户在地址栏输入的文本。
 * @returns 规范化的 HTTP(S) 地址。
 * @throws 空文本、超限地址、非法 URL、危险协议或内嵌凭据使调用失败。
 */
export function browserAddress(value: string): string {
  const input = value.trim();
  if (!input || input.length > 8192) throw new Error("浏览器地址为空或过长");
  const local = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:\/|$)/i.test(input);
  const explicit = /^[a-z][a-z\d+.-]*:/i.test(input);
  const candidate = local
    ? `http://${input}`
    : explicit
      ? input
      : /^[^\s/]+\.[^\s/]+(?::\d+)?(?:\/|$)/i.test(input)
        ? `https://${input}`
        : `https://www.google.com/search?q=${encodeURIComponent(input)}`;
  const url = new URL(candidate);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password)
    throw new Error("浏览器仅支持 HTTP(S) 地址");
  return url.href;
}

/**
 * 从窗口 IPC 建立有限导航动作，不接收脚本或权限变更。
 * @param value 未校验的工具栏请求。
 * @returns 独立的导航动作值。
 * @throws 动作、地址或页面身份无效时拒绝。
 */
export function parseBrowserNavigation(value: unknown): BrowserNavigation {
  const item = record(value),
    action = text(item, "action");
  if (action === "open") return { action, url: browserAddress(text(item, "url")) };
  const page = text(item, "page");
  if (!page || page.length > 128) throw new Error("浏览器页面身份无效");
  if (action === "navigate") return { action, page, url: browserAddress(text(item, "url")) };
  if (action === "back" || action === "forward" || action === "reload" || action === "close")
    return { action, page };
  throw new Error("浏览器导航动作无效");
}

/**
 * 校验主框架提供的网页位置与控制状态。
 * @param value 未校验的显示请求；null 表示隐藏。
 * @returns 有效页面矩形或 null。
 * @throws 控制者、身份、非有限坐标或尺寸无效时拒绝。
 */
export function parseBrowserPlacement(value: unknown): BrowserViewPlacement | null {
  if (value === null) return null;
  const item = record(value),
    bounds = record(item["bounds"]);
  const page = text(item, "page");
  if (!page || page.length > 128 || typeof item["human"] !== "boolean")
    throw new Error("浏览器显示参数无效");
  function number(key: string): number {
    const value = bounds[key];
    if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 100000)
      throw new Error("浏览器显示坐标无效");
    return value;
  }
  const rectangle = {
    x: number("x"),
    y: number("y"),
    width: number("width"),
    height: number("height"),
  };
  if (rectangle.width <= 0 || rectangle.height <= 0) throw new Error("浏览器显示尺寸无效");
  return { page, human: item["human"], bounds: rectangle };
}
