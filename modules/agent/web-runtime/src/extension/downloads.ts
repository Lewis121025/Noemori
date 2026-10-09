import { record, type DownloadState } from "../browser/contract.js";
import type { ExtensionPage, PageDownloads, Frame } from "./page.js";
import { Operation, type CdpSession, type CdpTransport } from "./transport.js";
import { captureHttp } from "./download-http.js";
import type { NativeBridge } from "./bridge.js";

const LIMIT = 32 * 1024 * 1024;
function blobListener(binding: string, key: string): void {
  const previous: unknown = Reflect.get(window, key);
  if (previous instanceof AbortController) previous.abort();
  const controller = new AbortController();
  Reflect.set(window, key, controller);
  document.addEventListener(
    "click",
    (event) => {
      const anchor = event.composedPath().find((node) => node instanceof HTMLAnchorElement);
      if (
        !(anchor instanceof HTMLAnchorElement) ||
        !anchor.hasAttribute("download") ||
        !/^(blob:|data:)/.test(anchor.href)
      )
        return;
      const href = anchor.href;
      const name = anchor.download || "download";
      const emit: unknown = Reflect.get(window, binding);
      if (typeof emit !== "function") throw new Error("受管下载绑定不存在");
      const id = crypto.randomUUID();
      // fetch 在捕获阶段同步取得 blob 引用，页面随后的 revoke 不会迫使宿主重发 HTTP 请求。
      void fetch(href, { signal: controller.signal })
        .then(async (response) => {
          if (!response.body) throw new Error("下载没有可读字节");
          const reader = response.body.getReader();
          let total = 0;
          const chunks: Uint8Array[] = [];
          for (;;) {
            const value = await reader.read();
            if (value.done) break;
            total += value.value.length;
            if (total > 32 * 1024 * 1024) {
              await reader.cancel();
              throw new Error("blob 下载超过 32 MiB");
            }
            chunks.push(value.value);
          }
          const bytes = new Uint8Array(total);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.length;
          }
          let text = "";
          for (let position = 0; position < bytes.length; position += 16384)
            text += String.fromCharCode(...bytes.subarray(position, position + 16384));
          emit(JSON.stringify({ id, name, data: btoa(text) }));
        })
        .catch((error: unknown) =>
          emit(
            JSON.stringify({
              id,
              name,
              error: error instanceof Error ? error.message : String(error),
            }),
          ),
        );
    },
    { capture: true, signal: controller.signal },
  );
}

type Armed = {
  page: ExtensionPage;
  controller: AbortController;
  operation: Operation;
  hint: { href: string; name: string } | null;
  binding: string;
  prior: Set<string>;
};
/** 只捕获明确登记的当前 target/frame 下载，保存的是原始响应而非二次请求。 */
export class Downloads implements PageDownloads {
  private readonly armed = new Map<string, Armed>();
  private readonly entries = new Map<string, DownloadState>();
  private readonly tasks = new Map<Promise<void>, string>();
  /** 固定会话与宿主落盘接口，页面不能选择输出目录或冒领其他会话下载。 */
  constructor(
    private readonly session: string,
    private readonly transport: CdpTransport,
    private readonly bridge: NativeBridge,
  ) {}
  /** 获取已确认的受管下载状态，不据此声称浏览器原生下载已完成。 */
  states(): DownloadState[] {
    return [...this.entries.values()].map((state) => ({ ...state }));
  }
  /** 触发前开启响应与 blob 监听，控制信号只属于本会话。 */
  async arm(page: ExtensionPage, operation: Operation): Promise<void> {
    if (this.armed.has(page.id)) throw new Error("此页面已有待结算的下载登记");
    const controller = new AbortController();
    const binding = `nui_${crypto.randomUUID().replaceAll("-", "")}`;
    this.armed.set(page.id, {
      page,
      controller,
      operation,
      hint: null,
      binding,
      prior: new Set(this.entries.keys()),
    });
    for (const frame of page.frames.values()) {
      await page.expression(frame, "void 0", operation);
      await this.transport.send(frame.session, "Runtime.addBinding", {
        name: binding,
        executionContextId: frame.world,
      });
      await page.expression(
        frame,
        `(${blobListener.toString()})(${JSON.stringify(binding)},${JSON.stringify(binding + "_listener")})`,
        operation,
      );
      await this.transport.send(frame.session, "Fetch.enable", {
        patterns: [{ urlPattern: "*", requestStage: "Response" }],
      });
    }
  }
  /** 登记当前动作实际锚点，HTTP download 属性不按时间或文件名猜测来源。 */
  hint(page: ExtensionPage, href: string | null, name: string | null): void {
    const armed = this.armed.get(page.id);
    if (armed && href !== null && name !== null) armed.hint = { href, name };
  }
  /** 处理当前 page 的真实协议事件；异步读取始终由下载管理器持有到结算。 */
  async event(
    page: ExtensionPage,
    source: CdpSession,
    method: string,
    values: Record<string, unknown>,
  ): Promise<void> {
    const armed = this.armed.get(page.id);
    if (method === "Fetch.requestPaused") {
      if (!armed) {
        await this.transport.send(source, "Fetch.continueRequest", { requestId: values.requestId });
        return;
      }
      const headers = this.headers(values.responseHeaders);
      const request = record(values.request);
      const attachment = headers.some(
        (header) =>
          header.name.toLowerCase() === "content-disposition" && /attachment/i.test(header.value),
      );
      const hinted = armed.hint?.href === request.url;
      const frame =
        typeof values.frameId === "string" ? page.frames.get(values.frameId) : undefined;
      if (
        !frame ||
        frame.session.sessionId !== source.sessionId ||
        (!attachment && !hinted) ||
        !Number.isInteger(values.responseStatusCode) ||
        (typeof values.responseStatusCode === "number" &&
          values.responseStatusCode >= 300 &&
          values.responseStatusCode < 400)
      ) {
        await this.transport.send(source, "Fetch.continueRequest", { requestId: values.requestId });
        return;
      }
      const state = this.begin(crypto.randomUUID(), armed.page.id, armed.hint?.name || "download");
      await this.track(
        armed.page.id,
        captureHttp({
          transport: this.transport,
          source,
          response: values,
          headers,
          state,
          signal: armed.controller.signal,
          operation: armed.operation,
          save: (data) => this.save(armed, state, data),
        }),
      );
    } else if (method === "Runtime.bindingCalled" && armed && values.name === armed.binding) {
      const frame = [...page.frames.values()].find(
        (frame) =>
          frame.world === values.executionContextId && frame.session.sessionId === source.sessionId,
      );
      if (
        !frame ||
        typeof values.payload !== "string" ||
        values.payload.length > (LIMIT * 4) / 3 + 8192
      )
        return;
      const value = record(JSON.parse(values.payload));
      const id = typeof value.id === "string" ? value.id : "";
      if (!id || this.entries.has(id)) throw new Error("blob 下载身份无效或重复");
      await this.track(armed.page.id, this.blob(armed, value));
    }
  }
  private headers(raw: unknown): { name: string; value: string }[] {
    if (!Array.isArray(raw)) return [];
    return raw.map((raw: unknown) => {
      const header = record(raw);
      if (typeof header.name !== "string" || typeof header.value !== "string")
        throw new Error("下载响应头无效");
      return { name: header.name, value: header.value };
    });
  }
  private begin(id: string, page: string, name: string): DownloadState {
    if (this.entries.size >= 100) throw new Error("受管下载达到会话数量上限");
    const state: DownloadState = { id, page, name, bytes: 0, status: "running", error: null };
    this.entries.set(id, state);
    return state;
  }
  private async save(armed: Armed, state: DownloadState, data: string): Promise<void> {
    if (data.length > (LIMIT * 4) / 3 + 4) throw new Error("下载数据超过 32 MiB");
    const result = await this.bridge.artifact(
      { id: state.id, session: this.session, page: armed.page.id, name: state.name, data },
      armed.controller.signal,
    );
    if (typeof result.bytes !== "number" || result.bytes > LIMIT)
      throw new Error("宿主下载回执无效");
    state.bytes = result.bytes;
    state.status = "completed";
  }
  private async track(page: string, work: Promise<void>): Promise<void> {
    this.tasks.set(work, page);
    try {
      await work;
    } finally {
      this.tasks.delete(work);
    }
  }
  private async blob(armed: Armed, value: Record<string, unknown>): Promise<void> {
    const state = this.begin(
      String(value.id),
      armed.page.id,
      typeof value.name === "string" ? value.name : "download",
    );
    try {
      if (typeof value.error === "string") throw new Error(value.error);
      if (typeof value.data !== "string") throw new Error("blob 下载字节缺失");
      await this.save(armed, state, value.data);
    } catch (error) {
      state.status = "failed";
      state.error = error instanceof Error ? error.message : String(error);
    }
  }
  /** 等待已登记页面的下载完整结算；超时不会再次点击或重新请求 URL。 */
  async wait(page: string, operation: Operation): Promise<DownloadState[]> {
    const armed = this.armed.get(page);
    if (!armed) throw new Error("页面尚未登记下载");
    for (;;) {
      operation.check();
      const files = this.states().filter((file) => file.page === page && !armed.prior.has(file.id));
      if (
        files.length &&
        files.every((file) => file.status !== "running") &&
        ![...this.tasks.values()].includes(page)
      ) {
        await this.disarm(armed);
        return files;
      }
      await operation.pause();
    }
  }
  private async disarm(armed: Armed): Promise<void> {
    this.armed.delete(armed.page.id);
    armed.controller.abort();
    const frames: Frame[] = [...armed.page.frames.values()];
    const cleanup = new Operation(new AbortController().signal, performance.now() + 2000);
    const failures: unknown[] = [];
    for (const frame of frames) {
      const results = await Promise.allSettled([
        this.transport.send(frame.session, "Fetch.disable"),
        this.transport.send(frame.session, "Runtime.removeBinding", { name: armed.binding }),
        armed.page.expression(
          frame,
          `(()=>{const key=${JSON.stringify(armed.binding + "_listener")};const value=Reflect.get(window,key);if(value instanceof AbortController)value.abort();Reflect.deleteProperty(window,key);})()`,
          cleanup,
        ),
      ]);
      for (const result of results) if (result.status === "rejected") failures.push(result.reason);
    }
    if (failures.length) throw new AggregateError(failures, "下载监听清理未完全确认");
  }
  /** 取消当前会话的捕获，已派发请求的失败或完成仍留在状态内。 */
  cancel(): void {
    for (const armed of this.armed.values()) armed.controller.abort();
  }
  /** 释放捕获并等待全部已启动读取任务；关闭后不再向页面派发输入。 */
  async close(): Promise<void> {
    this.cancel();
    const results = await Promise.allSettled([...this.tasks.keys()]);
    const cleanups = await Promise.allSettled(
      [...this.armed.values()].map((armed) => this.disarm(armed)),
    );
    const errors = [...results, ...cleanups].flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length) throw new AggregateError(errors, "下载资源未完全释放");
  }
}
