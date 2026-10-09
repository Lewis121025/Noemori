import { record } from "../browser/contract.js";

const FRAME = 1024 * 1024;
const LIMIT = 64 * 1024 * 1024;
const CHUNK = 192 * 1024;
function encode(bytes: Uint8Array): string {
  let text = "";
  for (let index = 0; index < bytes.length; index += 16384)
    text += String.fromCharCode(...bytes.subarray(index, index + 16384));
  return btoa(text);
}

/** Native Messaging 分块编码；每个 JSON 帧小于浏览器的 1 MiB 宿主输出限制。 */
export function frames(value: unknown): Record<string, unknown>[] {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if (bytes.length > LIMIT) throw new Error("Native Messaging 载荷超过 64 MiB");
  if (bytes.length < FRAME) return [record(value)];
  const transfer = crypto.randomUUID();
  const result: Record<string, unknown>[] = [];
  for (let offset = 0; offset < bytes.length; offset += CHUNK)
    result.push({
      type: "chunk",
      transfer,
      offset,
      total: bytes.length,
      data: encode(bytes.subarray(offset, offset + CHUNK)),
    });
  return result;
}

/** 单个串行传输的有界重组器；混入其他消息或乱序分块会关闭连接。 */
export class Reassembler {
  private transfer: string | null = null;
  private total = 0;
  private offset = 0;
  private pieces: Uint8Array[] = [];
  /** 验证并追加一帧；尚未完整时返回 null，错误时抛出且不交付部分消息。 */
  push(raw: unknown): Record<string, unknown> | null {
    const value = record(raw);
    if (new TextEncoder().encode(JSON.stringify(value)).length > FRAME)
      throw new Error("Native Messaging 帧超限");
    if (value.type !== "chunk") {
      if (this.transfer !== null) throw new Error("分块未完成时混入其他消息");
      return value;
    }
    if (
      typeof value.transfer !== "string" ||
      value.transfer.length > 128 ||
      typeof value.total !== "number" ||
      !Number.isSafeInteger(value.total) ||
      value.total <= 0 ||
      value.total > LIMIT ||
      typeof value.offset !== "number" ||
      !Number.isSafeInteger(value.offset) ||
      typeof value.data !== "string"
    )
      throw new Error("Native Messaging 分块字段无效");
    if (this.transfer === null) {
      this.transfer = value.transfer;
      this.total = value.total;
    }
    if (
      this.transfer !== value.transfer ||
      this.total !== value.total ||
      this.offset !== value.offset
    )
      throw new Error("Native Messaging 分块身份或顺序不符");
    const text = atob(value.data);
    const bytes = Uint8Array.from(text, (character) => character.charCodeAt(0));
    if (!bytes.length || bytes.length > CHUNK || bytes.length > this.total - this.offset)
      throw new Error("Native Messaging 分块数据超限");
    this.pieces.push(bytes);
    this.offset += bytes.length;
    if (this.offset !== this.total) return null;
    const all = new Uint8Array(this.total);
    let offset = 0;
    for (const piece of this.pieces) {
      all.set(piece, offset);
      offset += piece.length;
    }
    this.transfer = null;
    this.pieces = [];
    this.offset = 0;
    this.total = 0;
    return record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(all)));
  }
}

/** 已认证扩展到固定 Native Messaging 宿主的连接，不接受网页来源调用。 */
export class NativeBridge {
  private port: chrome.runtime.Port | null = null;
  private decoder = new Reassembler();
  private artifacts = new Map<
    string,
    { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }
  >();
  /** 接收器负责分派已检查的控制消息；断开回调必须暂停所有页面输入。 */
  constructor(
    private readonly received: (value: Record<string, unknown>) => Promise<void>,
    private readonly disconnected: (reason: string) => void,
  ) {}
  /** 用户明确连接时启动桥接进程；不自动恢复已失去的控制权。 */
  connect(): void {
    if (this.port) return;
    const port = chrome.runtime.connectNative("app.noemori.browser");
    this.port = port;
    this.decoder = new Reassembler();
    port.onMessage.addListener((raw: unknown) => {
      try {
        const value = this.decoder.push(raw);
        if (!value) return;
        if (value.type === "artifact_saved") {
          const id = typeof value.id === "string" ? value.id : "";
          const pending = this.artifacts.get(id);
          this.artifacts.delete(id);
          if (pending) {
            if (typeof value.error === "string") pending.reject(new Error(value.error));
            else pending.resolve(value);
          }
          return;
        }
        void this.received(value).catch((error: unknown) =>
          this.fail(error instanceof Error ? error.message : String(error)),
        );
      } catch (error) {
        this.fail(error instanceof Error ? error.message : String(error));
      }
    });
    port.onDisconnect.addListener(() =>
      this.fail(chrome.runtime.lastError?.message || "Native Messaging 已断开"),
    );
    this.send({
      type: "hello",
      version: 1,
      backend: navigator.userAgent.includes("Edg/") ? "edge" : "chrome",
      name: navigator.userAgent.includes("Edg/") ? "Microsoft Edge" : "Google Chrome",
    });
  }
  /** 发送一条完整协议消息；没有连接或载荷超限时拒绝，不创建 HTTP 控制服务。 */
  send(value: unknown): void {
    if (!this.port) throw new Error("尚未连接 Noemori");
    for (const frame of frames(value)) this.port.postMessage(frame);
  }
  /** 等待宿主确认受管文件落盘；页面文件字节不能直接写入任意目录。 */
  async artifact(
    value: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const id = typeof value.id === "string" ? value.id : "";
    if (!id || this.artifacts.has(id) || this.artifacts.size >= 100)
      throw new Error("下载身份重复或未结算下载数量超限");
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const abort = () => {
        this.artifacts.delete(id);
        reject(new Error("受管下载已取消"));
      };
      this.artifacts.set(id, {
        resolve: (result) => {
          signal.removeEventListener("abort", abort);
          resolve(result);
        },
        reject: (error) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      });
      signal.addEventListener("abort", abort, { once: true });
      try {
        this.send({ type: "artifact", ...value });
      } catch (error) {
        this.artifacts.delete(id);
        signal.removeEventListener("abort", abort);
        reject(error);
      }
      if (signal.aborted) abort();
    });
  }
  private fail(reason: string): void {
    if (!this.port) return;
    const port = this.port;
    this.port = null;
    for (const pending of this.artifacts.values()) pending.reject(new Error(reason));
    this.artifacts.clear();
    if (port) port.disconnect();
    this.disconnected(reason);
  }
}
