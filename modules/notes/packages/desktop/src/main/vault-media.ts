/**
 * 库内音视频的流式协议 `noemori-vault://vault/<库内路径>`。
 *
 * 音视频文件往往很大，经 IPC 读成整块字节再转 blob 会占满内存且无法拖动进度；
 * 这里按 HTTP Range 语义从磁盘流式读取。路径一律交给内核校验库根边界，
 * 只放行音视频类型，渲染进程不能借此读取其他文件。
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";

/** 协议名；渲染进程 CSP 的 `media-src` 必须同时放行。 */
export const VAULT_MEDIA_SCHEME = "noemori-vault";

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  flac: "audio/flac",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  ogv: "video/ogg",
};

/**
 * 按扩展名判断可流式播放的媒体类型。
 *
 * @returns MIME；不是音视频时返回 null。
 */
export function mediaMime(path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return MEDIA_TYPES[ext] ?? null;
}

/**
 * 从协议 URL 取出库内相对路径。
 *
 * @returns 解码后的相对路径；主机名不对、含空段、`.`、`..` 或空字符时返回 null。
 */
export function vaultMediaPath(url: string): string | null {
  // 不经 URL 规范化：`%2E%2E` 会被合并成上级目录，必须在原文上逐段判定。
  const prefix = `${VAULT_MEDIA_SCHEME}://vault/`;
  if (!url.startsWith(prefix)) return null;
  const segments = (url.slice(prefix.length).split(/[?#]/, 1)[0] ?? "").split("/");
  let decoded: string[];
  try {
    decoded = segments.map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
  if (
    decoded.length === 0 ||
    decoded.some((part) => part === "" || part === "." || part === ".." || part.includes("\0"))
  )
    return null;
  return decoded.join("/");
}

/** 字节区间（含两端）。 */
export type ByteRange = { start: number; end: number };

/**
 * 解析单段 `Range: bytes=…` 请求头。
 *
 * @param header 请求头原文；缺失或格式不合法时整篇返回（与 HTTP 语义一致）。
 * @param size 文件字节数。
 * @returns 区间；`null` 表示返回整篇；`"unsatisfiable"` 表示起点越界（416）。
 */
export function parseRange(
  header: string | null,
  size: number,
): ByteRange | null | "unsatisfiable" {
  if (header === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return null;
  const [, first = "", last = ""] = match;
  if (first === "" && last === "") return null;
  if (first === "") {
    const suffix = Number(last);
    if (suffix === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  if (start >= size) return "unsatisfiable";
  const end = last === "" ? size - 1 : Math.min(Number(last), size - 1);
  return end < start ? null : { start, end };
}

/**
 * 创建协议处理函数。
 *
 * @param resolve 把库内相对路径校验并转换为绝对路径；越界或不存在时抛错。
 * @returns 供 `protocol.handle` 使用的处理函数；错误以 HTTP 状态返回，不抛给 Electron。
 */
export function createVaultMediaHandler(
  resolve: (rel: string) => Promise<string>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const rel = vaultMediaPath(request.url);
    if (rel === null) return new Response("无效的媒体地址", { status: 400 });
    const mime = mediaMime(rel);
    if (mime === null) return new Response("只提供音视频文件", { status: 415 });
    let absolute: string;
    let size: number;
    try {
      absolute = await resolve(rel);
      const info = await stat(absolute);
      if (!info.isFile()) return new Response("媒体不存在", { status: 404 });
      size = info.size;
    } catch {
      return new Response("媒体不存在", { status: 404 });
    }
    const range = parseRange(request.headers.get("range"), size);
    if (range === "unsatisfiable")
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    const { start, end } = range ?? { start: 0, end: size - 1 };
    const headers = new Headers({
      "Content-Type": mime,
      "Accept-Ranges": "bytes",
      "Content-Length": String(size === 0 ? 0 : end - start + 1),
    });
    if (range !== null) headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
    // Node 的 stream/web 与 DOM 的 ReadableStream 类型声明不同源，运行时是同一实现。
    const body =
      size === 0
        ? null
        : (Readable.toWeb(
            createReadStream(absolute, { start, end }),
          ) as ReadableStream<Uint8Array>);
    return new Response(body, { status: range === null ? 200 : 206, headers });
  };
}
