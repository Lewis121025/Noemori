import { randomUUID } from "node:crypto";
import type { ElementHandle, FileChooser, Frame, Locator, Page } from "playwright-core";
import type { BrowserSettings, Observation } from "./contract.js";
import { BrowserDialogs } from "./dialogs.js";

/** 元素句柄保持节点身份；语义指纹拒绝虚拟列表复用同一节点后改变操作对象。 */
type Reference = { handle: ElementHandle; fingerprint: string };

/** 框架采集共享同一引用序列；局部失败保留已取得的证据并明确记入 warnings。 */
type PageContent = {
  warnings: string[];
  elements: Observation["elements"];
  sections: string[];
  truncated: boolean;
};

class InterruptedBrowserOperation extends Error {}
class NavigatedDuringObservation extends Error {}

/** 页面状态由浏览器运行时独占；导航、崩溃与人工接管使旧观察失效。 */
export class BrowserPage {
  readonly id = randomUUID();
  generation = 0;
  crashed = false;
  readonly dialogs: BrowserDialogs;
  fileChooser: FileChooser | null = null;
  observation: Observation | null = null;
  private imageLayout: string | null = null;
  private references = new Map<string, Reference>();

  /**
   * 绑定页面事件；网页地址和控件始终使用同一 Page 对象。
   * @param page 当前会话独占的页面。
   * @param changed 状态变化通知，必须同步快速返回且不得抛出异常。
   * @throws 弹窗监视器的异步绑定错误留到后续 ready/guard 调用报告。
   */
  constructor(
    readonly page: Page,
    changed: () => void,
  ) {
    this.dialogs = new BrowserDialogs(page, changed);
    page.on("framenavigated", () => {
      this.generation++;
      this.observation = null;
      this.imageLayout = null;
    });
    page.on("crash", () => {
      this.crashed = true;
      this.observation = null;
    });
    page.on("filechooser", (chooser) => {
      this.fileChooser = chooser;
    });
  }

  /** 当前弹窗由协议事件维护，包含用户手动关闭后的状态。 */
  get dialog() {
    return this.dialogs.current;
  }

  /**
   * 有界等待一条浏览器原语；弹窗或取消会交回控制，迟到句柄仍由本操作释放。
   * cleanup 仅用于释放已经按下的输入状态，允许在现有弹窗打开时发出清理事件。
   * @param operation 单次浏览器调用；支持取消的原语必须接收传入的 signal，阻止中断后继续输入。
   * @param options 取消与时间边界；release 用于回收未交付的远程句柄。
   * @returns 原调用结果；有副作用的调用中断时，调用者必须记录为未确认。
   * @throws 弹窗、中断、超时或浏览器自身错误，不继续发送后续输入。
   */
  async guard<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    options: {
      release?: (value: T) => Promise<void>;
      timeout?: number;
      cleanup?: boolean;
      signal?: AbortSignal;
    } = {},
  ): Promise<T> {
    await this.dialogs.ready();
    if (options.signal?.aborted) throw new InterruptedBrowserOperation("浏览器操作已取消");
    if (this.dialog && !options.cleanup)
      throw new InterruptedBrowserOperation("页面出现对话框，请先处理 dialog 后重新观察");
    let interrupted = false;
    const cancellation = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe = () => {};
    let onAbort = () => {};
    const blocked = new Promise<never>((_, reject) => {
      const stop = (message: string) => {
        interrupted = true;
        const error = new InterruptedBrowserOperation(message);
        cancellation.abort(error);
        reject(error);
      };
      unsubscribe = this.dialogs.subscribe(() => {
        if (this.dialog) stop("页面操作期间出现对话框，请先处理 dialog 后重新观察");
      });
      onAbort = () => stop("浏览器操作已取消，当前动作可能已生效");
      options.signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(
        () => stop("页面操作超过等待期限，请检查页面状态"),
        options.timeout ?? 5000,
      );
      if (this.dialog && options.cleanup) stop("对话框打开期间已发送输入释放，需先处理 dialog");
    });
    try {
      const result = operation(cancellation.signal).then(async (value) => {
        if (interrupted) {
          if (options.release) await options.release(value);
          throw new InterruptedBrowserOperation("已中断的操作不能提交迟到结果");
        }
        return value;
      });
      return await Promise.race([result, blocked]);
    } finally {
      clearTimeout(timer);
      unsubscribe();
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * 释放观察持有的远程节点；页面已关闭时 Playwright 仍允许 dispose。
   * @returns 引用全部释放后完成；调用开始时旧观察立即失效。
   * @throws 远程句柄释放失败时抛出错误，不能宣称已经完整回收。
   */
  async invalidate(): Promise<void> {
    this.observation = null;
    this.imageLayout = null;
    const references = this.references;
    this.references = new Map();
    await Promise.all([...references.values()].map(({ handle }) => handle.dispose()));
  }

  /**
   * 校验观察归属，拒绝导航前或人工接管前的动作；不改变页面。
   * @param id 工具动作引用的观察标识。
   * @returns 当前仍有效的观察。
   * @throws 观察缺失或标识不匹配时抛出错误。
   */
  requireObservation(id: string): Observation {
    if (!this.observation || this.observation.id !== id)
      throw new Error("观察已失效，请重新 observe 后操作");
    return this.observation;
  }

  /**
   * 获取仍连接且语义未改变的真实节点；失效时不会退回位置编号或模糊匹配。
   * @param observation 必须仍有效的观察标识。
   * @param ref 该观察分配的控件引用。
   * @returns 与观察时身份一致的句柄；异步等待后使用前须再次核验。
   * @throws 观察或引用失效、节点被复用、弹窗中断或页面读取失败。
   */
  async element(observation: string, ref: string): Promise<ElementHandle> {
    this.requireObservation(observation);
    const reference = this.references.get(ref);
    if (!reference) throw new Error("控件引用不属于当前观察");
    const current = await this.guard(() => reference.handle.evaluate(describeElement));
    if (!current.connected || current.fingerprint !== reference.fingerprint)
      throw new Error("控件已替换或内容已改变，请重新 observe");
    return reference.handle;
  }

  /**
   * 截图绑定文档、视口、布局及控件语义；无关视频或画布像素刷新不使固定位置失效。
   * @param observation 坐标动作引用的截图观察。
   * @returns 当前布局仍符合截图时完成，不派发输入。
   * @throws 观察失效、缺少截图、布局改变、弹窗中断或读取失败。
   */
  async verifyLayout(observation: string): Promise<void> {
    this.requireObservation(observation);
    if (!this.imageLayout) throw new Error("坐标动作需要先 screenshot");
    if ((await this.layout()) !== this.imageLayout)
      throw new Error("截图之后页面已经变化，请重新 screenshot");
  }

  private async layout(): Promise<string> {
    const frames: unknown[] = [];
    for (const frame of this.page.frames())
      frames.push([frame.url(), await this.guard(() => frame.evaluate(layoutSignature))]);
    return JSON.stringify(frames);
  }

  /**
   * 按 CSS 像素返回视口 JPEG，坐标与图片维度一致。
   * @returns 不超过 5 MiB 的图像字节；布局与观察绑定由 observe 完成。
   * @throws 图像超限、页面关闭、弹窗中断或截图超时。
   */
  async screenshot(): Promise<Buffer> {
    const bytes = await this.guard(() =>
      this.page.screenshot({
        type: "jpeg",
        quality: 80,
        scale: "css",
        timeout: 5000,
      }),
    );
    if (bytes.length > 5 * 1024 * 1024) throw new Error("浏览器截图超过 5 MiB");
    return bytes;
  }

  /**
   * 采集正文、框架及可交互控件；返回截断事实，不把缺失控件冒充完整页面。
   * @param settings 宿主冻结的正文和控件预算。
   * @param image 是否同时绑定当前布局并返回视口图像。
   * @param check 当前执行的取消和预算检查，失败时须抛出错误。
   * @returns 同一代页面的观察及可选图像；局部框架读取失败记入 warnings。
   * @throws 页面持续导航、布局不稳定、弹窗、中断、超时或资源释放失败。
   */
  async observe(
    settings: BrowserSettings,
    image: boolean,
    check: () => void,
  ): Promise<{ observation: Observation; image?: { format: "jpeg"; data: string } }> {
    for (let attempt = 0; ; attempt++) {
      check();
      try {
        return await this.capture(settings, image, check);
      } catch (error) {
        // 只重采集没有副作用的观察；两次都不稳定时交回模型，不重复任何输入动作。
        if (!(error instanceof NavigatedDuringObservation) || attempt >= 1) throw error;
      }
    }
  }

  private async capture(
    settings: BrowserSettings,
    image: boolean,
    check: () => void,
  ): Promise<{ observation: Observation; image?: { format: "jpeg"; data: string } }> {
    await this.invalidate();
    if (this.crashed || this.page.isClosed()) throw new Error("页面已崩溃或关闭");
    if (this.dialog) throw new Error("页面有待处理对话框，请先使用 dialog");
    const generation = this.generation;
    const content = await this.captureContent(settings.max_elements, check);
    const fullText = content.sections.join("\n\n");
    check();
    const text = [...fullText].slice(0, settings.max_chars).join("");
    const viewport =
      this.page.viewportSize() ||
      (await this.guard(() =>
        this.page.evaluate(() => ({ width: innerWidth, height: innerHeight })),
      ));
    const observation: Observation = {
      id: randomUUID(),
      page: this.id,
      url: this.page.url(),
      title: await this.guard(() => this.page.title()),
      text,
      elements: content.elements,
      truncated: content.truncated || text.length < fullText.length,
      warnings: content.warnings,
      viewport,
    };
    let bytes: Buffer | undefined;
    let layout: string | undefined;
    if (image) {
      layout = await this.layout();
      bytes = await this.screenshot();
      if ((await this.layout()) !== layout)
        throw new Error("截图期间页面布局发生变化，请重新 screenshot");
    }
    if (this.generation !== generation) {
      await this.invalidate();
      throw new NavigatedDuringObservation("观察期间页面持续导航，请重新观察");
    }
    this.observation = observation;
    if (bytes) {
      this.imageLayout = layout ?? null;
      return { observation, image: { format: "jpeg", data: bytes.toString("base64") } };
    }
    return { observation };
  }

  private async captureContent(maximum: number, check: () => void): Promise<PageContent> {
    const content: PageContent = { warnings: [], elements: [], sections: [], truncated: false };
    for (const [index, frame] of this.page.frames().entries()) {
      check();
      if (index >= 32) {
        content.truncated = true;
        break;
      }
      const frameId = `frame-${index}`;
      try {
        await this.captureFrame(frame, frameId, maximum, check, content);
      } catch (error) {
        if (error instanceof InterruptedBrowserOperation) throw error;
        content.warnings.push(`${frameId} 观察不完整：${reason(error)}`);
      }
    }
    return content;
  }

  private async captureFrame(
    frame: Frame,
    frameId: string,
    maximum: number,
    check: () => void,
    content: PageContent,
  ): Promise<void> {
    const body = frame.locator("body");
    const structure = await this.guard((signal) => body.ariaSnapshot({ timeout: 2000, signal }));
    content.sections.push(`[${frameId}] ${frame.url()}\n${structure}`);
    const candidates = frame.locator(
      'a[href],button,input:not([type="hidden"]),textarea,select,[role],[contenteditable="true"],[tabindex],[onclick],summary',
    );
    const offsets = await this.guard(() =>
      candidates.evaluateAll(
        (nodes, remaining) =>
          nodes
            .flatMap((node, index) => {
              const box = node.getBoundingClientRect();
              return box.width > 0 &&
                box.height > 0 &&
                box.bottom > 0 &&
                box.right > 0 &&
                box.top < innerHeight &&
                box.left < innerWidth
                ? [index]
                : [];
            })
            .slice(0, remaining + 1),
        maximum - content.elements.length,
      ),
    );
    for (const offset of offsets) {
      check();
      if (content.elements.length >= maximum) {
        content.truncated = true;
        break;
      }
      await this.captureElement(candidates.nth(offset), frameId, content.elements);
    }
  }

  private async captureElement(
    locator: Locator,
    frameId: string,
    elements: Observation["elements"],
  ): Promise<void> {
    if (!(await this.guard(() => locator.isVisible()))) return;
    const handle = await this.guard(() => locator.elementHandle({ timeout: 1000 }), {
      release: async (handle) => {
        await handle?.dispose();
      },
    });
    if (!handle) return;
    let retained = false;
    try {
      const info = await this.guard(() => handle.evaluate(describeElement));
      if (!info.connected || !info.inViewport) return;
      const ref = `e${elements.length + 1}`;
      this.references.set(ref, { handle, fingerprint: info.fingerprint });
      retained = true;
      elements.push({ ref, frame: frameId, description: info.description });
    } finally {
      if (!retained) await handle.dispose();
    }
  }
}

// 在各框架中采集可见布局；开放 Shadow DOM 一并检查，像素动画不进入控件定位契约。
function layoutSignature(): unknown[] {
  const geometry: unknown[] = [innerWidth, innerHeight, scrollX, scrollY];
  const roots: (Document | ShadowRoot)[] = [document];
  for (const root of roots) {
    for (const element of root.querySelectorAll("*")) {
      if (element.shadowRoot) roots.push(element.shadowRoot);
      const box = element.getBoundingClientRect();
      if (
        box.width === 0 ||
        box.height === 0 ||
        box.bottom <= 0 ||
        box.right <= 0 ||
        box.top >= innerHeight ||
        box.left >= innerWidth
      )
        continue;
      const interactive = element.matches(
        'a,button,input,select,textarea,[role],[onclick],[contenteditable="true"]',
      );
      const style = getComputedStyle(element);
      geometry.push([
        element.tagName,
        ...[box.x, box.y, box.width, box.height].map((value) => Math.round(value * 10)),
        style.visibility,
        style.opacity,
        style.pointerEvents,
        style.zIndex,
        style.clipPath,
        element.getAttribute("aria-label"),
        element.getAttribute("role"),
        element.getAttribute("href"),
        element.getAttribute("disabled"),
        element.getAttribute("aria-checked"),
        interactive ? (element.textContent || "").slice(0, 500) : "",
      ]);
    }
  }
  return geometry;
}

/**
 * 统一异常文本，保留有限诊断信息，避免工具堆栈挤占模型上下文。
 * @param error 捕获的原始异常。
 * @returns 最多 2000 个字符串代码单元的诊断文本；不输出完整堆栈。
 */
export function reason(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2000);
}

// 该函数在页面上下文内执行，必须自包含；密码字段只暴露类型，不读取其值。
function describeElement(element: Element): {
  connected: boolean;
  inViewport: boolean;
  fingerprint: string;
  description: string;
} {
  const tag = element.tagName.toLowerCase();
  const type = element.getAttribute("type") || "";
  const role = element.getAttribute("role") || tag;
  const labels =
    "labels" in element && element.labels instanceof NodeList
      ? [...element.labels].map((label) => label.textContent || "").join(" ")
      : "";
  const labelled = (element.getAttribute("aria-labelledby") || "")
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => element.ownerDocument.getElementById(id)?.textContent || "")
    .join(" ");
  const name =
    element.getAttribute("aria-label") ||
    labelled ||
    labels ||
    element.getAttribute("placeholder") ||
    element.textContent ||
    element.getAttribute("title") ||
    "";
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim().slice(0, 400);
  const context = element.closest('tr,[role="row"],li')?.textContent || "";
  const href = element.getAttribute("href") || "";
  const fingerprint = JSON.stringify([tag, type, role, normalize(name), href, normalize(context)]);
  const state = ["disabled", "checked", "selected", "aria-expanded", "aria-checked"].flatMap(
    (key) => (element.hasAttribute(key) ? [`${key}=${element.getAttribute(key)}`] : []),
  );
  const value =
    type !== "password" && tag !== "input" && tag !== "textarea"
      ? ""
      : type === "password"
        ? " [password]"
        : "value" in element && typeof element.value === "string"
          ? ` value=${JSON.stringify(element.value.slice(0, 300))}`
          : "";
  const box = element.getBoundingClientRect();
  const view = element.ownerDocument.defaultView;
  const inViewport = Boolean(
    view &&
    box.bottom > 0 &&
    box.right > 0 &&
    box.top < view.innerHeight &&
    box.left < view.innerWidth,
  );
  return {
    connected: element.isConnected,
    inViewport,
    fingerprint,
    description: `${role}${type ? `(${type})` : ""} ${JSON.stringify(normalize(name))}${value}${href ? ` href=${href.slice(0, 500)}` : ""}${state.length ? ` [${state.join(", ")}]` : ""}${context ? ` context=${JSON.stringify(normalize(context))}` : ""}`,
  };
}
