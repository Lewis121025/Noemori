/** 单次辅助操作的资源边界；所有值由 Rust 配置提供，模型不能直接修改。 */
export type Limits = {
  max_chars: number;
  max_pages: number;
  image_edge: number;
  max_download_bytes: number;
};

/** 已由宿主解析的代理；认证仅走进程输入，不写入日志或模型结果。 */
export type Proxy = {
  server: string;
  username?: string;
  password?: string;
  /** 系统代理可能按域名路由；仅宿主解析器设置，匿名读取的固定代理继续使用已校验 IP。 */
  resolve_hostname?: boolean;
};

/** Rust 和辅助进程之间的完整输入，图像或 PDF 字节不使用公共临时文件传递。 */
export type WorkerInput = {
  operation: "page" | "pdf" | "search";
  url: string;
  limits: Limits;
  timeout_ms: number;
  data?: string;
  browser_path?: string;
  proxy?: Proxy;
};

/** 搜索适配器需要完整 HTML；它只在宿主内解析，不能作为模型正文返回。 */
export type HtmlSnapshot = { url: string; html: string; warnings: string[] };

/** 一页视觉观察；图片按页编号排列，字节进入模型的原生图像块。 */
export type PageImage = { page: number; format: "jpeg"; data: string };

/** 完整读取结果；截断和部分缺失必须明确表达，不能冒充完整页面。 */
export type ReadResult = {
  title?: string;
  url: string;
  text: string;
  truncated: boolean;
  warnings: string[];
  images: PageImage[];
};

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("辅助进程输入必须是对象");
  }
  return value as Record<string, unknown>;
}

function positive(value: unknown, maximum: number, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`辅助进程 ${field} 超出允许范围`);
  }
  return value;
}

/**
 * 校验进程边界输入，避免任意 JSON 对象绕过操作类型和资源限制。
 * @param value 解析后的输入。
 * @returns 可执行的明确操作。
 * @throws 输入不符合契约时抛出具体错误。
 */
export function parseInput(value: unknown): WorkerInput {
  const input = record(value);
  const operation = input.operation;
  if (operation !== "page" && operation !== "pdf" && operation !== "search")
    throw new Error("未知辅助操作");
  if (typeof input.url !== "string") throw new Error("缺少来源 URL");
  const limits = record(input.limits);
  const result: WorkerInput = {
    operation,
    url: input.url,
    timeout_ms: positive(input.timeout_ms, 2_147_483_647, "剩余时间预算"),
    limits: {
      max_chars: positive(limits.max_chars, 200_000, "正文上限"),
      max_pages: positive(limits.max_pages, 20, "图片页数上限"),
      image_edge: positive(limits.image_edge, 4000, "图片尺寸上限"),
      max_download_bytes: positive(limits.max_download_bytes, 48 * 1024 * 1024, "下载字节上限"),
    },
  };
  if (typeof input.browser_path === "string") result.browser_path = input.browser_path;
  if (result.operation === "pdf") {
    if (typeof input.data !== "string" || input.data.length > 64 * 1024 * 1024) {
      throw new Error("PDF 字节缺失或超过输入上限");
    }
    result.data = input.data;
  }
  if (input.proxy !== undefined && input.proxy !== null) {
    const proxy = record(input.proxy);
    if (typeof proxy.server !== "string") throw new Error("代理地址无效");
    result.proxy = { server: proxy.server };
    if (typeof proxy.username === "string") result.proxy.username = proxy.username;
    if (typeof proxy.password === "string") result.proxy.password = proxy.password;
  }
  return result;
}

/** 按 Unicode 字符截取正文，避免在中文和代理字符对中间截断。 */
export function trimText(text: string, maximum: number): { text: string; truncated: boolean } {
  let count = 0;
  let end = 0;
  for (const character of text) {
    if (count === maximum) return { text: text.slice(0, end), truncated: true };
    end += character.length;
    count++;
  }
  return { text, truncated: false };
}
