import { record, type DownloadState } from "../browser/contract.js";
import type { CdpSession, CdpTransport, Operation } from "./transport.js";

const LIMIT = 32 * 1024 * 1024;
/** 原始响应的唯一读取者；保存回执与浏览器响应回填分别结算。 */
export type HttpCapture = {
  transport: CdpTransport;
  source: CdpSession;
  response: Record<string, unknown>;
  headers: { name: string; value: string }[];
  state: DownloadState;
  signal: AbortSignal;
  operation: Operation;
  save(data: string): Promise<void>;
};

function reason(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2000);
}

function filename(headers: HttpCapture["headers"], fallback: string): string {
  const header =
    headers.find((header) => header.name.toLowerCase() === "content-disposition")?.value || "";
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header)?.[1];
  return encoded
    ? decodeURIComponent(encoded)
    : /filename="([^"]+)"/i.exec(header)?.[1] ||
        /filename=([^;]+)/i.exec(header)?.[1]?.trim() ||
        fallback;
}

async function bounded(work: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("响应流清理超过两秒预算")), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        abort = () => reject(new Error("下载已取消"));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}

async function readBody(
  capture: HttpCapture,
  handle: string,
): Promise<{ data: string; size: number }> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    capture.operation.check();
    if (capture.signal.aborted) throw new Error("下载已取消");
    const result = record(
      await abortable(
        capture.transport.send(capture.source, "IO.read", { handle, size: 192 * 1024 }),
        capture.signal,
      ),
    );
    const data = result.data;
    if (typeof data !== "string") throw new Error("下载流数据无效");
    const bytes =
      result.base64Encoded === true
        ? Uint8Array.from(atob(data), (value) => value.charCodeAt(0))
        : new TextEncoder().encode(data);
    size += bytes.length;
    if (size > LIMIT) throw new Error("下载流超过 32 MiB");
    chunks.push(bytes);
    if (result.eof === true) break;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  let text = "";
  for (let offset = 0; offset < bytes.length; offset += 16384)
    text += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
  return { data: btoa(text), size };
}

/** 读取并保存一次原始 HTTP 响应；失败写入 state，绝不重发原请求。
 * @param capture 已授权 target、frame、request 的响应与宿主保存接口。
 * @returns 保存、回填和有界清理均已结算；completed 只表示受管文件已经落盘。
 */
export async function captureHttp(capture: HttpCapture): Promise<void> {
  const { transport, source, response, headers, state, signal } = capture;
  const requestId = response.requestId;
  let handle: string | null = null;
  let closing: Promise<void> | undefined;
  const closeStream = (): Promise<void> => {
    if (!handle) return Promise.resolve();
    return (closing ??= bounded(transport.send(source, "IO.close", { handle })).catch(
      (error: unknown) => {
        state.error = `${state.error ? `${state.error}；` : ""}响应流清理失败：${reason(error)}`;
      },
    ));
  };
  const abort = (): void => {
    void closeStream();
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    state.name = filename(headers, state.name);
    const length = headers.find((header) => header.name.toLowerCase() === "content-length")?.value;
    if (length && Number(length) > LIMIT) throw new Error("下载响应声明的长度超过 32 MiB");
    const stream = record(
      await transport.send(source, "Fetch.takeResponseBodyAsStream", { requestId }),
    );
    if (typeof stream.stream !== "string") throw new Error("下载没有响应流");
    handle = stream.stream;
    const body = await readBody(capture, handle);
    if (signal.aborted) throw new Error("下载已取消");
    await capture.save(body.data);
    await transport.send(source, "Fetch.fulfillRequest", {
      requestId,
      responseCode: response.responseStatusCode,
      responseHeaders: [
        ...headers.filter(
          (header) =>
            !["content-encoding", "content-length", "transfer-encoding"].includes(
              header.name.toLowerCase(),
            ),
        ),
        { name: "Content-Length", value: String(body.size) },
      ],
      body: body.data,
    });
  } catch (error) {
    if (state.status === "completed")
      state.error = `受管文件已保存，浏览器原生响应回填未确认：${reason(error)}`;
    else {
      state.status = "failed";
      state.error = reason(error);
    }
    try {
      await bounded(
        transport.send(source, "Fetch.failRequest", { requestId, errorReason: "Aborted" }),
      );
    } catch (cleanup) {
      state.error += `；中止原始响应失败：${reason(cleanup)}`;
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await closeStream();
  }
}
