/** 笔记只保存入口地址和显示高度，浏览过程与网站数据不写入正文。 */
export type WebPage = { url: string; height: number };

/** 原生视图使用窗口客户区坐标；网页完整范围与可见裁剪范围分别传递。 */
export type PageRect = { x: number; y: number; width: number; height: number };

/** 每个挂载实例独立拥有身份；null 范围隐藏视图，列表中消失则销毁。 */
export type WebPageLayout = {
  id: string;
  url: string;
  bounds: PageRect | null;
  clip: PageRect | null;
};

/** 只提交变化的布局和已卸载身份，避免滚动时跨进程复制全部离屏节点。 */
export type WebPageUpdate = {
  layouts: readonly WebPageLayout[];
  removed: readonly string[];
};

/** IPC 一次提交的数量上限；发送端按此拆分批次，卸载再多节点也不突破协议。 */
export const MAX_WEB_PAGE_UPDATES = 1000;

/** 网站的瞬时浏览状态，不参与编辑器历史或笔记保存。 */
export type WebPageState = {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  error: string | null;
  canBack: boolean;
  canForward: boolean;
  /** 焦点归属用于激活正确的分栏，不把 DOM 焦点从网页抢回正文。 */
  focused: boolean;
};

/** 浏览控制不暴露脚本执行、磁盘、权限或任意 Electron 消息能力。 */
export type WebPageAction = "back" | "forward" | "reload";

/** 网页能力由主窗口的 preload 注入；网站自身没有这组接口。 */
export type WebPageApi = {
  sync: (update: WebPageUpdate) => Promise<void>;
  action: (id: string, action: WebPageAction) => Promise<void>;
  subscribe: (changed: (state: WebPageState) => void) => () => void;
};

/**
 * 校验网页入口和重定向地址，只接受 HTTP/HTTPS，拒绝凭据和控制字符。
 * @param value 用户输入或网站提供的地址。
 * @returns 规范 URL。
 * @throws 地址、协议或凭据不符合网页契约时抛出中文错误。
 */
export function webPageUrl(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 8192 ||
    /\s/u.test(value) ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    throw new Error("请输入完整的 HTTP 或 HTTPS 网页地址");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("请输入完整的 HTTP 或 HTTPS 网页地址");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("网页仅支持不含账号密码的 HTTP 或 HTTPS 地址");
  return url.href;
}

/**
 * 校验持久化配置；不修正越界高度，避免源码和文档模型产生隐性差异。
 * @param value 未验证的 JSON 对象。
 * @returns 入口地址与 240–1200 像素的整数高度。
 * @throws 配置不完整或无效时抛错，由解析层保留为普通代码块。
 */
export function parseWebPage(value: unknown): WebPage {
  if (typeof value !== "object" || value === null || !("url" in value) || !("height" in value))
    throw new Error("网页配置缺少地址或高度");
  return { url: webPageUrl(value.url), height: webPageHeight(value.height) };
}

/**
 * 统一配置与 schema 的高度契约，避免恢复记录绕过持久化校验。
 * @param value 未验证高度。
 * @returns 240–1200 像素的整数。
 * @throws 非整数或越界时拒绝配置。
 */
export function webPageHeight(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 240 || value > 1200)
    throw new Error("网页高度必须是 240–1200 像素的整数");
  return value;
}

/**
 * 校验实例身份，避免把任意字符串当作原生视图句柄。
 * @param value 未验证的实例身份。
 * @returns 合法 UUID 原文。
 * @throws 不是 UUID 时拒绝请求。
 */
export function webPageId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value))
    throw new Error("网页实例无效");
  return value;
}

function pageRect(value: unknown): PageRect | null {
  if (value === null) return null;
  if (
    typeof value !== "object" ||
    !("x" in value) ||
    !("y" in value) ||
    !("width" in value) ||
    !("height" in value)
  )
    throw new Error("网页范围无效");
  const { x, y, width, height } = value;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number" ||
    ![x, y, width, height].every(Number.isFinite) ||
    Math.abs(x) > 100000 ||
    Math.abs(y) > 100000 ||
    width <= 0 ||
    width > 10000 ||
    height <= 0 ||
    height > 10000
  )
    throw new Error("网页范围无效");
  return { x, y, width, height };
}

/**
 * 校验整批视图布局，验证完成前不提交任何原生视图变化。
 * @param value 未验证的 IPC 布局数组。
 * @returns 身份唯一、地址与裁剪范围完整的布局。
 * @throws 重复身份、非法地址或不完整范围时拒绝整批请求。
 */
export function parseWebPageLayouts(value: unknown): WebPageLayout[] {
  if (!Array.isArray(value) || value.length > MAX_WEB_PAGE_UPDATES) throw new Error("网页布局无效");
  const ids = new Set<string>();
  return value.map((item: unknown) => {
    if (
      typeof item !== "object" ||
      item === null ||
      !("id" in item) ||
      !("url" in item) ||
      !("bounds" in item) ||
      !("clip" in item)
    )
      throw new Error("网页布局无效");
    const id = webPageId(item.id);
    if (ids.has(id)) throw new Error("网页实例重复");
    ids.add(id);
    const bounds = pageRect(item.bounds);
    const clip = pageRect(item.clip);
    if ((bounds === null) !== (clip === null)) throw new Error("网页裁剪范围不完整");
    return { id, url: webPageUrl(item.url), bounds, clip };
  });
}

/**
 * 验证一次增量提交；同一身份不能同时更新和卸载，验证后再改变原生视图。
 * @param value 未验证的 IPC 布局变化。
 * @returns 已校验的变化布局和卸载身份。
 * @throws 缺少字段、身份重复或协议不完整时拒绝整批请求。
 */
export function parseWebPageUpdate(value: unknown): WebPageUpdate {
  if (
    typeof value !== "object" ||
    value === null ||
    !("layouts" in value) ||
    !("removed" in value) ||
    !Array.isArray(value.removed) ||
    value.removed.length > MAX_WEB_PAGE_UPDATES
  )
    throw new Error("网页更新无效");
  const layouts = parseWebPageLayouts(value.layouts);
  if (layouts.length + value.removed.length > MAX_WEB_PAGE_UPDATES)
    throw new Error("网页更新数量超限");
  const seen = new Set(layouts.map((layout) => layout.id));
  const removed = value.removed.map((raw: unknown) => {
    const id = webPageId(raw);
    if (seen.has(id)) throw new Error("网页更新身份重复");
    seen.add(id);
    return id;
  });
  return { layouts, removed };
}

/**
 * 校验跨进程浏览状态，避免未知字段类型污染正文控件。
 * @param value 主进程传来的状态。
 * @returns 已校验的瞬时浏览状态。
 * @throws 身份、地址或状态字段无效时拒绝响应。
 */
export function parseWebPageState(value: unknown): WebPageState {
  if (
    typeof value !== "object" ||
    value === null ||
    !("id" in value) ||
    !("url" in value) ||
    !("title" in value) ||
    typeof value.title !== "string" ||
    !("loading" in value) ||
    typeof value.loading !== "boolean" ||
    !("error" in value) ||
    (value.error !== null && typeof value.error !== "string") ||
    !("canBack" in value) ||
    typeof value.canBack !== "boolean" ||
    !("canForward" in value) ||
    typeof value.canForward !== "boolean" ||
    !("focused" in value) ||
    typeof value.focused !== "boolean"
  )
    throw new Error("网页状态无效");
  return {
    id: webPageId(value.id),
    url: webPageUrl(value.url),
    title: value.title,
    loading: value.loading,
    error: value.error,
    canBack: value.canBack,
    canForward: value.canForward,
    focused: value.focused,
  };
}

/**
 * 可见区域取交集，完全离屏时不创建或显示原生视图。
 * @param left 网页或已裁剪区域。
 * @param right 下一层裁剪边界。
 * @returns 正面积交集；没有交集时返回 null，不抛出业务异常。
 */
export function intersectPageRects(left: PageRect, right: PageRect): PageRect | null {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const endX = Math.min(left.x + left.width, right.x + right.width);
  const endY = Math.min(left.y + left.height, right.y + right.height);
  return endX <= x || endY <= y ? null : { x, y, width: endX - x, height: endY - y };
}
