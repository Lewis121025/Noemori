import { describeElement, layoutSignature } from "../browser/dom.js";
import {
  record,
  navigationUrl,
  type BrowserAction,
  type Observation,
  type TabState,
} from "../browser/contract.js";
import {
  observeDom,
  inspectDom,
  controlDom,
  findDom,
  readDom,
  fileInputDom,
  uploadDom,
} from "./dom.js";
import { Operation, runtimeValue, type CdpSession, type CdpTransport } from "./transport.js";

/** frame 的实际 debugger 会话；子目标通过 flat session 独立寻址。 */
export type Frame = {
  id: string;
  parent?: string;
  session: CdpSession;
  world?: number;
  url: string;
};
type Reference = { frame: Frame; local: string };
/** 原始协议事件的下载接入点；只接收当前租约内的 frame。 */
export interface PageDownloads {
  arm(page: ExtensionPage, operation: Operation): Promise<void>;
  event(
    page: ExtensionPage,
    source: CdpSession,
    method: string,
    values: Record<string, unknown>,
  ): Promise<void>;
  hint(page: ExtensionPage, href: string | null, name: string | null): void;
}
function text(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} 不是有效文本`);
  return value;
}
function numeric(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} 不是有限数字`);
  return value;
}

/** 一个明确共享的真实标签页；观察、远程引用与像素布局只属于此租约。 */
export class ExtensionPage {
  readonly frames = new Map<string, Frame>();
  private readonly targets = new Map<string, CdpSession>();
  private readonly attaching = new Set<Promise<void>>();
  private refs = new Map<string, Reference>();
  private observation: Observation | null = null;
  private imageLayout: string | null = null;
  private epoch = 0;
  private connected = false;
  private connecting: Promise<void> | null = null;
  private leaseGeneration = 0;
  private dialog: TabState["dialog"] = null;
  private chooser: { session: CdpSession; node: number } | null = null;
  /** 绑定固定 tabId 与连接代次，传输只能由宿主扩展提供。 */
  constructor(
    readonly id: string,
    readonly tab: number,
    readonly transport: CdpTransport,
    private readonly downloads: PageDownloads,
  ) {}
  /** 获取不含调试权限的标签页状态，读取失败不伪造页面标题。 */
  async state(): Promise<TabState> {
    const tab = await chrome.tabs.get(this.tab);
    return {
      id: this.id,
      url: tab.url || "",
      title: tab.title || "",
      crashed: false,
      dialog: this.dialog,
      file_chooser: this.chooser !== null,
    };
  }
  /** 首次操作附着已共享页面；被拒绝时保持未派发，不尝试操控其他页面。 */
  async attach(): Promise<void> {
    if (this.connected) return;
    if (this.connecting) return this.connecting;
    const generation = this.leaseGeneration;
    const work = this.connect(generation);
    this.connecting = work;
    try {
      await work;
    } finally {
      if (this.connecting === work) this.connecting = null;
    }
  }
  private async connect(generation: number): Promise<void> {
    await this.transport.attach(this.tab);
    this.connected = true;
    if (generation !== this.leaseGeneration) return;
    const root = { tabId: this.tab };
    this.targets.set("root", root);
    await this.configure(root);
  }
  private async configure(session: CdpSession): Promise<void> {
    await this.transport.send(session, "Page.enable");
    await this.transport.send(session, "Runtime.enable");
    await this.transport.send(session, "DOM.enable");
    await this.transport.send(session, "Page.setInterceptFileChooserDialog", { enabled: true });
    await this.transport.send(session, "Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [{ type: "iframe", exclude: false }],
    });
    await this.refresh(session);
  }
  private async refresh(session: CdpSession): Promise<void> {
    const result = record(await this.transport.send(session, "Page.getFrameTree"));
    const visit = (value: unknown, parent?: string): void => {
      const tree = record(value);
      const data = record(tree.frame);
      const id = text(data.id, "frameId");
      const prior = this.frames.get(id);
      if (!prior?.session.sessionId || session.sessionId) {
        const owner = typeof data.parentId === "string" ? data.parentId : (parent ?? prior?.parent);
        const world =
          prior?.session.sessionId === session.sessionId && prior?.url === data.url
            ? prior?.world
            : undefined;
        this.frames.set(id, {
          id,
          session,
          url: typeof data.url === "string" ? data.url : "",
          ...(owner ? { parent: owner } : {}),
          ...(world === undefined ? {} : { world }),
        });
      }
      if (Array.isArray(tree.childFrames)) for (const child of tree.childFrames) visit(child, id);
    };
    visit(result.frameTree);
  }
  /** 处理本标签页协议事件；导航与子目标变动使旧观察失效。 */
  async event(source: CdpSession, method: string, values: Record<string, unknown>): Promise<void> {
    if (method === "Target.attachedToTarget") {
      const info = record(values.targetInfo);
      if (info.type !== "iframe") return;
      const id = text(values.sessionId, "sessionId");
      const session = { tabId: this.tab, sessionId: id };
      this.targets.set(id, session);
      const work = this.configure(session);
      this.attaching.add(work);
      try {
        await work;
      } finally {
        this.attaching.delete(work);
      }
      this.invalidate();
    } else if (method === "Target.detachedFromTarget") {
      const id = text(values.sessionId, "sessionId");
      this.targets.delete(id);
      for (const [frame, entry] of this.frames)
        if (entry.session.sessionId === id) this.frames.delete(frame);
      this.invalidate();
    } else if (
      method === "Page.frameNavigated" ||
      method === "Page.frameDetached" ||
      method === "Runtime.executionContextsCleared"
    ) {
      if (method === "Runtime.executionContextsCleared") {
        for (const frame of this.frames.values())
          if (frame.session.sessionId === source.sessionId) delete frame.world;
      } else {
        const frameId = method === "Page.frameNavigated" ? record(values.frame).id : values.frameId;
        if (typeof frameId === "string") this.frames.delete(frameId);
      }
      this.invalidate();
    } else if (method === "Page.javascriptDialogOpening") {
      this.dialog = {
        type: text(values.type, "dialog type"),
        message: text(values.message, "dialog message"),
      };
      this.invalidate();
    } else if (method === "Page.javascriptDialogClosed") {
      this.dialog = null;
      this.invalidate();
    } else if (method === "Page.fileChooserOpened") {
      this.chooser = { session: source, node: numeric(values.backendNodeId, "file input") };
    }
    await this.downloads.event(this, source, method, values);
  }
  /** 释放调试连接和远程引用，保留用户的真实标签页。 */
  async detach(): Promise<void> {
    this.leaseGeneration++;
    this.invalidate();
    // 附着失败本身没有要释放的租约；附着成功则必须等到 detach 确认后再结算关闭。
    if (this.connecting) await Promise.allSettled([this.connecting]);
    if (this.connected) {
      await this.transport.detach(this.tab);
      this.connected = false;
    }
    this.frames.clear();
    this.targets.clear();
  }
  /** 已经由浏览器断开的连接不能被下一条脚本自动接回。 */
  disconnected(): void {
    this.leaseGeneration++;
    this.connected = false;
    this.invalidate();
    this.frames.clear();
    this.targets.clear();
  }
  /** 关联原生操作后使全部观察与像素定位失效。 */
  invalidate(): void {
    this.epoch++;
    this.observation = null;
    this.imageLayout = null;
    this.refs.clear();
  }
  private async world(frame: Frame, operation: Operation): Promise<number> {
    operation.check();
    if (frame.world === undefined) {
      const value = record(
        await this.transport.send(frame.session, "Page.createIsolatedWorld", {
          frameId: frame.id,
          worldName: "Noemori UI",
        }),
      );
      frame.world = numeric(value.executionContextId, "executionContextId");
    }
    operation.check();
    return frame.world;
  }
  /** 在目标 frame 的隔离世界运行 SDK 内部函数；模型不能提供任意页面代码。 */
  async expression(frame: Frame, expression: string, operation: Operation): Promise<unknown> {
    const contextId = await this.world(frame, operation);
    const result = await this.transport.send(frame.session, "Runtime.evaluate", {
      contextId,
      expression,
      returnByValue: true,
      awaitPromise: true,
      objectGroup: "noemori-ui",
    });
    operation.check();
    return runtimeValue(result);
  }
  private root(): Frame {
    const root = [...this.frames.values()].find((frame) => !frame.parent);
    if (!root) throw new Error("没有有效的主 frame，请重新观察");
    return root;
  }
  /** 采集跨 frame 的有界 DOM 与真实引用，局部读取失败保留具体原因。 */
  async observe(operation: Operation): Promise<Observation> {
    await this.attach();
    operation.check();
    if (this.dialog) throw new Error("先处理页面对话框");
    while (this.attaching.size) await Promise.all([...this.attaching]);
    for (const session of this.targets.values()) await this.refresh(session);
    const epoch = this.epoch;
    const id = crypto.randomUUID();
    const refs = new Map<string, Reference>();
    const elements: Observation["elements"] = [];
    const sections: string[] = [];
    const warnings: string[] = [];
    let title = "";
    let url = "";
    let viewport = { width: 0, height: 0 };
    let truncated = false;
    for (const frame of this.frames.values()) {
      try {
        const value = record(
          await this.expression(
            frame,
            `(${observeDom.toString()})(${describeElement.toString()},${JSON.stringify(this.key())},${JSON.stringify(id)})`,
            operation,
          ),
        );
        if (!frame.parent) {
          title = text(value.title, "title");
          url = text(value.url, "url");
          const view = record(value.viewport);
          viewport = {
            width: numeric(view.width, "width"),
            height: numeric(view.height, "height"),
          };
        }
        sections.push(`[frame ${frame.id}] ${text(value.text, "text")}`);
        if (Array.isArray(value.elements))
          for (const raw of value.elements) {
            if (elements.length >= 250) {
              truncated = true;
              break;
            }
            const entry = record(raw);
            const ref = `e${elements.length}`;
            refs.set(ref, { frame, local: text(entry.ref, "ref") });
            elements.push({
              ref,
              frame: frame.id,
              description: text(entry.description, "description"),
            });
          }
        truncated ||= value.truncated === true;
      } catch (error) {
        warnings.push(
          `frame ${frame.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    operation.check();
    if (this.epoch !== epoch) throw new Error("观察期间 frame 发生变化，请重新 observe");
    if (!viewport.width || !viewport.height)
      throw new Error(`主 frame 读取失败：${warnings.join("；")}`);
    const fullText = sections.join("\n");
    const content = [...fullText].slice(0, 24000).join("");
    this.refs = refs;
    this.imageLayout = null;
    this.observation = {
      id,
      page: this.id,
      title,
      url,
      viewport,
      text: content,
      elements,
      warnings,
      truncated: truncated || content.length < fullText.length,
    };
    return this.observation;
  }
  private key(): string {
    return `__noemori_${this.id}`;
  }
  private require(action: { observation: string }): Observation {
    if (!this.observation || this.observation.id !== action.observation)
      throw new Error("观察已失效，请重新 observe");
    return this.observation;
  }
  private async reference(
    action: { observation: string; ref: string },
    operation: Operation,
  ): Promise<{ entry: Reference; point: Record<string, unknown> }> {
    this.require(action);
    const entry = this.refs.get(action.ref);
    if (!entry) throw new Error("控件不属于当前观察");
    const point = record(
      await this.expression(
        entry.frame,
        `(${inspectDom.toString()})(${describeElement.toString()},${JSON.stringify(this.key())},${JSON.stringify(action.observation)},${JSON.stringify(entry.local)})`,
        operation,
      ),
    );
    this.require(action);
    return { entry, point };
  }
  private async offset(
    frame: Frame,
    x: number,
    y: number,
    operation: Operation,
  ): Promise<{ x: number; y: number }> {
    let current = frame;
    while (current.parent) {
      const parent = this.frames.get(current.parent);
      if (!parent) throw new Error("父 frame 已失效");
      const owner = record(
        await this.transport.send(parent.session, "DOM.getFrameOwner", { frameId: current.id }),
      );
      const resolved = record(
        await this.transport.send(parent.session, "DOM.resolveNode", {
          backendNodeId: numeric(owner.backendNodeId, "frame owner"),
          executionContextId: await this.world(parent, operation),
        }),
      );
      const objectId = text(record(resolved.object).objectId, "frame owner object");
      try {
        const point = record(
          runtimeValue(
            await this.transport.send(parent.session, "Runtime.callFunctionOn", {
              objectId,
              returnByValue: true,
              arguments: [{ value: x }, { value: y }],
              functionDeclaration:
                "function(x,y){const box=this.getBoundingClientRect();const m=getComputedStyle(this).transform;if(m!=='none'){const matrix=new DOMMatrix(m);if(matrix.b||matrix.c||matrix.a<=0||matrix.d<=0)throw new Error('旋转或镜像 iframe 不支持像素定位');}if(!this.offsetWidth||!this.offsetHeight)throw new Error('iframe 已不可见');const sx=box.width/this.offsetWidth,sy=box.height/this.offsetHeight;x=box.x+(this.clientLeft+x)*sx;y=box.y+(this.clientTop+y)*sy;if(x<0||y<0||x>=innerWidth||y>=innerHeight)throw new Error('父 iframe 不在视口内');let hit=document.elementFromPoint(x,y);while(hit?.shadowRoot){const nested=hit.shadowRoot.elementFromPoint(x,y);if(!nested||nested===hit)break;hit=nested;}if(hit!==this)throw new Error('父 iframe 被遮挡，拒绝点击其他对象');return {x,y};}",
            }),
          ),
        );
        x = numeric(point.x, "frame x");
        y = numeric(point.y, "frame y");
      } finally {
        await this.transport.send(parent.session, "Runtime.releaseObject", { objectId });
      }
      current = parent;
      operation.check();
    }
    return { x, y };
  }
  private async mouse(
    x: number,
    y: number,
    button: string,
    clicks: number,
    operation: Operation,
  ): Promise<void> {
    operation.dispatch();
    await this.transport.send({ tabId: this.tab }, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button,
      clickCount: clicks,
    });
    // 已按下的输入必须释放，清理命令不受取消阻挡。
    await this.transport.send({ tabId: this.tab }, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button,
      clickCount: clicks,
    });
    operation.check();
  }
  /** 发送一对键盘事件；不跨调用保留按键状态。 */
  async keyboard(key: string, operation: Operation, focus?: () => Promise<void>): Promise<void> {
    const parts = key.split("+");
    const name = parts.pop();
    if (!name) throw new Error("按键为空");
    let modifiers = 0;
    for (const part of parts) {
      const value = {
        Alt: 1,
        Control: 2,
        Ctrl: 2,
        Meta: 4,
        Shift: 8,
        ControlOrMeta: navigator.platform.includes("Mac") ? 4 : 2,
      }[part];
      if (value === undefined) throw new Error("键盘修饰键无效");
      modifiers |= value;
    }
    const aliases: Record<string, { key: string; code: string; windowsVirtualKeyCode: number }> = {
      Space: { key: " ", code: "Space", windowsVirtualKeyCode: 32 },
      Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
      Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
      Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
      Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
      Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
      End: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
      Home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
      ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
      ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
      ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
      ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
    };
    const data =
      aliases[name] ??
      (/^[a-zA-Z0-9]$/.test(name)
        ? {
            key: name,
            code: /^[0-9]$/.test(name) ? `Digit${name}` : `Key${name.toUpperCase()}`,
            windowsVirtualKeyCode: name.toUpperCase().charCodeAt(0),
          }
        : undefined);
    if (!data) throw new Error("按键不支持");
    if (focus) await focus();
    operation.dispatch();
    await this.transport.send({ tabId: this.tab }, "Input.dispatchKeyEvent", {
      type: "keyDown",
      modifiers,
      ...data,
      ...((!(modifiers & 7) && data.key.length === 1) || name === "Enter"
        ? { text: name === "Enter" ? "\r" : data.key }
        : {}),
    });
    await this.transport.send({ tabId: this.tab }, "Input.dispatchKeyEvent", {
      type: "keyUp",
      modifiers,
      ...data,
    });
    operation.check();
  }
  private async layout(operation: Operation): Promise<string> {
    const frames: unknown[] = [];
    for (const frame of this.frames.values())
      frames.push([
        frame.id,
        frame.url,
        await this.expression(frame, `(${layoutSignature.toString()})()`, operation),
      ]);
    return JSON.stringify(frames);
  }
  /** 执行页面动作；命令进入此方法前已经由 Rust 与共享 TS 契约验证。 */
  async execute(
    action: Extract<BrowserAction, { page: string }>,
    operation: Operation,
    refresh = true,
  ): Promise<Record<string, unknown>> {
    operation.check();
    await this.attach();
    operation.check();
    if (action.action === "preview") {
      const image = record(await this.transport.send({ tabId: this.tab }, "Page.captureScreenshot", { format: "jpeg", quality: 65, captureBeyondViewport: false }));
      operation.check();
      return { image_data: text(image.data, "preview"), image_format: "jpeg" };
    }
    if (action.action === "observe") return { observation: await this.observe(operation) };
    if (action.action === "arm_download") {
      await this.downloads.arm(this, operation);
      return {};
    }
    if (this.dialog && action.action !== "dialog" && action.action !== "close")
      throw new Error("先处理页面对话框");
    switch (action.action) {
      case "dialog":
        {
          if (!this.dialog) throw new Error("页面没有对话框");
          operation.dispatch();
          await this.transport.send({ tabId: this.tab }, "Page.handleJavaScriptDialog", {
            accept: action.accept,
            ...(action.text === undefined ? {} : { promptText: action.text }),
          });
          this.dialog = null;
        }
        break;
      case "close": {
        operation.dispatch();
        await chrome.tabs.remove(this.tab);
        return {};
      }
      case "navigate":
      case "reload":
      case "back":
      case "forward":
        await this.navigate(action, operation);
        break;
      case "read":
        return this.readText(action, operation);
      case "find":
      case "wait":
        await this.findText(action, operation);
        break;
      case "screenshot":
        return this.capture(operation);
      case "pointer":
      case "drag":
      case "scroll":
        await this.pixelInput(action, operation);
        break;
      case "press":
      case "type":
        await this.keyboardInput(action, operation);
        break;
      case "click":
      case "hover":
      case "fill":
      case "select":
      case "check":
        await this.elementInput(action, operation);
        break;
      case "choose_files":
      case "upload":
        throw new Error("上传必须包含宿主读取的固定字节");
      default:
        throw new Error(`页面动作尚未接入：${action.action}`);
    }
    operation.check();
    return this.dialog || !refresh ? {} : { observation: await this.observe(operation) };
  }
  private async readText(
    action: Extract<BrowserAction, { action: "read" }>,
    operation: Operation,
  ): Promise<Record<string, unknown>> {
    let total = 0;
    let remaining = 24000;
    const output: string[] = [];
    for (const frame of this.frames.values()) {
      const prefix = `[frame ${frame.id}] `;
      const start = total;
      const offset = Math.max(0, action.offset - start - prefix.length);
      const value = record(
        await this.expression(frame, `(${readDom.toString()})(${offset})`, operation),
      );
      const length = numeric(value.total_chars, "正文总长度");
      total += prefix.length + length + 1;
      if (remaining && action.offset < total) {
        const leading =
          action.offset > start ? [...prefix].slice(action.offset - start).join("") : prefix;
        const content = leading + text(value.text, "正文文字") + "\n";
        const chunk = [...content].slice(0, remaining).join("");
        output.push(chunk);
        remaining -= [...chunk].length;
      }
    }
    const textPage = output.join("");
    const next = action.offset + [...textPage].length;
    return {
      text_page: {
        text: textPage,
        offset: action.offset,
        next_offset: next < total ? next : null,
        total_chars: total,
      },
    };
  }
  private async findText(
    action: Extract<BrowserAction, { action: "find" | "wait" }>,
    operation: Operation,
  ): Promise<void> {
    for (;;) {
      const matches: Frame[] = [];
      for (const frame of this.frames.values())
        if (
          (await this.expression(
            frame,
            `(${findDom.toString()})(${JSON.stringify(action.text)},${action.exact ?? true},false)`,
            operation,
          )) === true
        )
          matches.push(frame);
      if (action.action === "find") {
        if (matches.length !== 1)
          throw new Error(
            matches.length ? "跨 frame 文字命中多个控件，请提供唯一目标" : "没有找到目标文字",
          );
        const frame = matches[0];
        if (!frame) throw new Error("查找结果已经失效");
        operation.dispatch();
        await this.expression(
          frame,
          `(${findDom.toString()})(${JSON.stringify(action.text)},${action.exact ?? true},true)`,
          operation,
        );
        break;
      }
      if (matches.length > 0 === (action.state === "visible")) break;
      await operation.pause();
    }
  }
  private async capture(operation: Operation): Promise<Record<string, unknown>> {
    const observation = await this.observe(operation);
    const root = this.root();
    const before = await this.layout(operation);
    const metrics = record(
      await this.expression(
        root,
        "({x:scrollX,y:scrollY,width:innerWidth,height:innerHeight,dpr:devicePixelRatio})",
        operation,
      ),
    );
    const image = record(
      await this.transport.send({ tabId: this.tab }, "Page.captureScreenshot", {
        format: "jpeg",
        quality: 75,
        captureBeyondViewport: false,
        clip: {
          x: numeric(metrics.x, "scroll x"),
          y: numeric(metrics.y, "scroll y"),
          width: numeric(metrics.width, "width"),
          height: numeric(metrics.height, "height"),
          scale: 1 / numeric(metrics.dpr, "dpr"),
        },
      }),
    );
    const after = await this.layout(operation);
    if (before !== after) throw new Error("截图期间布局变化，请重新 screenshot");
    this.imageLayout = after;
    return { observation, image_data: text(image.data, "screenshot"), image_format: "jpeg" };
  }
  private async pixelInput(
    action: Extract<BrowserAction, { action: "pointer" | "drag" | "scroll" }>,
    operation: Operation,
  ): Promise<void> {
    const observation = this.require(action);
    const bounds = (x: number, y: number): void => {
      if (
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        x < 0 ||
        y < 0 ||
        x >= observation.viewport.width ||
        y >= observation.viewport.height
      )
        throw new Error("像素坐标越界");
    };
    if (action.action === "pointer") bounds(action.x, action.y);
    if (action.action === "drag") {
      bounds(action.from_x, action.from_y);
      bounds(action.to_x, action.to_y);
    }
    if (
      action.action !== "scroll" &&
      (!this.imageLayout || this.imageLayout !== (await this.layout(operation)))
    )
      throw new Error("像素动作必须使用当前布局的截图");
    if (action.action === "scroll") {
      operation.dispatch();
      await this.transport.send({ tabId: this.tab }, "Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: 10,
        y: 10,
        deltaX: action.x,
        deltaY: action.y,
      });
    } else if (action.action === "pointer")
      await this.mouse(action.x, action.y, action.button, action.clicks, operation);
    else {
      operation.dispatch();
      await this.transport.send({ tabId: this.tab }, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: action.from_x,
        y: action.from_y,
        button: "left",
        clickCount: 1,
      });
      let x = action.from_x;
      let y = action.from_y;
      try {
        for (let index = 1; index <= 20; index++) {
          operation.check();
          x = action.from_x + ((action.to_x - action.from_x) * index) / 20;
          y = action.from_y + ((action.to_y - action.from_y) * index) / 20;
          await this.transport.send({ tabId: this.tab }, "Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x,
            y,
            button: "left",
            buttons: 1,
          });
        }
      } finally {
        await this.transport.send({ tabId: this.tab }, "Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x,
          y,
          button: "left",
          clickCount: 1,
        });
      }
    }
  }
  private async keyboardInput(
    action: Extract<BrowserAction, { action: "press" | "type" }>,
    operation: Operation,
  ): Promise<void> {
    this.require(action);
    const focus = async (): Promise<void> => {
      if (!action.ref) return;
      const { entry } = await this.reference(
        { observation: action.observation, ref: action.ref },
        operation,
      );
      operation.dispatch();
      await this.expression(
        entry.frame,
        `(${controlDom.toString()})(${inspectDom.toString()},${describeElement.toString()},${JSON.stringify(this.key())},${JSON.stringify(action.observation)},${JSON.stringify(entry.local)},'focus',null)`,
        operation,
      );
    };
    if (action.action === "press") await this.keyboard(action.key, operation, focus);
    else {
      await focus();
      operation.dispatch();
      await this.transport.send({ tabId: this.tab }, "Input.insertText", { text: action.text });
    }
  }
  private async elementInput(
    action: Extract<BrowserAction, { action: "click" | "hover" | "fill" | "select" | "check" }>,
    operation: Operation,
  ): Promise<void> {
    const { entry, point } = await this.reference(action, operation);
    if (action.action === "fill" || action.action === "select") {
      operation.dispatch();
      await this.expression(
        entry.frame,
        `(${controlDom.toString()})(${inspectDom.toString()},${describeElement.toString()},${JSON.stringify(this.key())},${JSON.stringify(action.observation)},${JSON.stringify(entry.local)},${JSON.stringify(action.action)},${JSON.stringify(action.action === "fill" ? action.text : { values: action.values, by: action.by ?? "label" })})`,
        operation,
      );
    } else {
      const position = await this.offset(
        entry.frame,
        numeric(point.x, "x"),
        numeric(point.y, "y"),
        operation,
      );
      if (action.action === "hover") {
        operation.dispatch();
        await this.transport.send({ tabId: this.tab }, "Input.dispatchMouseEvent", {
          type: "mouseMoved",
          ...position,
        });
      } else if (action.action !== "check" || point.checked !== action.checked) {
        this.downloads.hint(
          this,
          typeof point.href === "string" ? point.href : null,
          typeof point.download === "string" ? point.download : null,
        );
        await this.mouse(position.x, position.y, "left", 1, operation);
      }
    }
  }
  private async navigate(
    action: Extract<BrowserAction, { action: "navigate" | "reload" | "back" | "forward" }>,
    operation: Operation,
  ): Promise<void> {
    if (action.action === "navigate") {
      operation.dispatch();
      await this.transport.send({ tabId: this.tab }, "Page.navigate", { url: action.url });
      this.invalidate();
    } else if (action.action === "reload") {
      operation.dispatch();
      await this.transport.send({ tabId: this.tab }, "Page.reload");
      this.invalidate();
    } else {
      const history = record(
        await this.transport.send({ tabId: this.tab }, "Page.getNavigationHistory"),
      );
      if (!Array.isArray(history.entries)) throw new Error("导航历史无效");
      const index =
        numeric(history.currentIndex, "history index") + (action.action === "back" ? -1 : 1);
      const entry = history.entries[index];
      if (entry) {
        navigationUrl(text(record(entry).url, "history URL"));
        operation.dispatch();
        await this.transport.send({ tabId: this.tab }, "Page.navigateToHistoryEntry", {
          entryId: numeric(record(entry).id, "history id"),
        });
        this.invalidate();
      }
    }
  }

  /** 将固定字节写入已观察文件输入或真实 chooser 节点，不读取任意本地路径。 */
  async upload(
    action: { observation?: string; ref?: string },
    files: { name: string; mime_type: string; data: string }[],
    operation: Operation,
  ): Promise<Record<string, unknown>> {
    await this.attach();
    let session: CdpSession;
    let objectId: string;
    if (action.observation !== undefined && action.ref !== undefined) {
      const target = await this.reference(
        { observation: action.observation, ref: action.ref },
        operation,
      );
      session = target.entry.frame.session;
      const result = record(
        await this.transport.send(session, "Runtime.evaluate", {
          contextId: await this.world(target.entry.frame, operation),
          expression: `(${fileInputDom.toString()})(${JSON.stringify(this.key())},${JSON.stringify(action.observation)},${JSON.stringify(target.entry.local)})`,
          returnByValue: false,
        }),
      );
      if (result.exceptionDetails) throw new Error("文件输入已经失效");
      objectId = text(record(result.result).objectId, "file input object");
    } else {
      if (!this.chooser) throw new Error("页面没有等待选择的文件输入");
      session = this.chooser.session;
      const result = record(
        await this.transport.send(session, "DOM.resolveNode", { backendNodeId: this.chooser.node }),
      );
      objectId = text(record(result.object).objectId, "chooser object");
    }
    try {
      operation.dispatch();
      runtimeValue(
        await this.transport.send(session, "Runtime.callFunctionOn", {
          objectId,
          functionDeclaration: `function(files){return (${uploadDom.toString()})(this,files)}`,
          arguments: [{ value: files }],
          returnByValue: true,
        }),
      );
      this.chooser = null;
      operation.check();
      return { observation: await this.observe(operation) };
    } finally {
      await this.transport.send(session, "Runtime.releaseObject", { objectId });
    }
  }
}
