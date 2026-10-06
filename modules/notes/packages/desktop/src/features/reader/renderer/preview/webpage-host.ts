import {
  intersectPageRects,
  MAX_WEB_PAGE_UPDATES,
  type PageRect,
  type WebPageApi,
  type WebPageLayout,
  type WebPageState,
} from "../../shared/webpage";

/** 网页挂载器只接收受限浏览能力；节点卸载即注销，不向网站注入应用接口。 */
export type WebPageHost = {
  mount: (
    host: HTMLElement,
    url: string,
    changed: (state: WebPageState) => void,
  ) => { id: string; destroy: () => void };
  action: WebPageApi["action"];
};

/** 同一帧复用公共祖先的几何和样式，不能跨帧缓存滚动或布局结果。 */
type ViewportRead = {
  blocked: boolean;
  areas: Map<HTMLElement, { rect: PageRect; style: CSSStyleDeclaration }>;
};
/** 挂载身份与异步提交绑定；旧请求只能影响它捕获的实例。 */
type PageMount = {
  id: string;
  host: HTMLElement;
  container: HTMLElement | null;
  url: string;
  changed: (state: WebPageState) => void;
  intersecting: boolean;
  layout: WebPageLayout | undefined;
  syncError: string | null;
};

function viewportRead(): ViewportRead {
  return {
    blocked: document.querySelector("dialog[open], [popover]:popover-open") !== null,
    areas: new Map(),
  };
}
function area(element: HTMLElement, read: ViewportRead) {
  let cached = read.areas.get(element);
  if (!cached) {
    const bounds = element.getBoundingClientRect();
    cached = {
      rect: { x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height },
      style: getComputedStyle(element),
    };
    read.areas.set(element, cached);
  }
  return cached;
}
function measure(host: HTMLElement, read: ViewportRead): Pick<WebPageLayout, "bounds" | "clip"> {
  if (read.blocked || !host.isConnected || host.closest("[inert], [hidden]"))
    return { bounds: null, clip: null };
  const bounds = area(host, read).rect;
  let clip = intersectPageRects(bounds, {
    x: 0,
    y: 0,
    width: window.innerWidth,
    height: window.innerHeight,
  });
  for (
    let parent: HTMLElement | null = host;
    parent !== null && clip;
    parent = parent.parentElement
  ) {
    const { rect, style } = area(parent, read);
    if (style.display === "none" || style.visibility === "hidden")
      return { bounds: null, clip: null };
    const clipsX = /auto|scroll|hidden|clip/.test(style.overflowX);
    const clipsY = /auto|scroll|hidden|clip/.test(style.overflowY);
    if (clipsX || clipsY)
      clip = intersectPageRects(clip, {
        x: clipsX ? rect.x : clip.x,
        y: clipsY ? rect.y : clip.y,
        width: clipsX ? rect.width : clip.width,
        height: clipsY ? rect.height : clip.height,
      });
  }
  return clip ? { bounds, clip } : { bounds: null, clip: null };
}

/**
 * 计算网页与所有滚动祖先的交集；模态层、inert 或隐藏正文不会暴露原生网页。
 * @param host 正文中预留的网页区域。
 * @returns 完整范围与可见范围；不可见时都为 null，不抛出业务异常。
 */
export function webPageViewport(host: HTMLElement): Pick<WebPageLayout, "bounds" | "clip"> {
  return measure(host, viewportRead());
}

function sameRect(left: PageRect | null, right: PageRect | null): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.x === right.x &&
      left.y === right.y &&
      left.width === right.width &&
      left.height === right.height)
  );
}

/** 布局提交只属于它捕获的挂载身份，合并与失败处理不访问 DOM。 */
class WebPageUpdates {
  private readonly layouts = new Map<string, WebPageLayout>();
  private readonly removed = new Set<string>();
  private flight: Promise<boolean> | null = null;

  constructor(
    private readonly api: WebPageApi,
    private readonly pages: ReadonlyMap<string, PageMount>,
    private readonly schedule: () => void,
  ) {}

  get pending(): boolean {
    return this.flight !== null || this.layouts.size > 0 || this.removed.size > 0;
  }
  layout(layout: WebPageLayout): void {
    this.layouts.set(layout.id, layout);
  }
  remove(id: string): void {
    this.layouts.delete(id);
    this.removed.add(id);
  }

  flush(): Promise<boolean> {
    if (this.flight) return this.flight;
    if (!this.pending) return Promise.resolve(true);
    const layouts = [...this.layouts.values()].slice(0, MAX_WEB_PAGE_UPDATES);
    const update = {
      layouts,
      removed: [...this.removed].slice(0, MAX_WEB_PAGE_UPDATES - layouts.length),
    };
    const owners = update.layouts.map((layout) => this.pages.get(layout.id));
    for (const layout of update.layouts) this.layouts.delete(layout.id);
    for (const id of update.removed) this.removed.delete(id);
    this.flight = Promise.resolve()
      .then(() => this.api.sync(update))
      .then(
        () => {
          for (const owner of owners)
            if (owner && this.pages.get(owner.id) === owner) owner.syncError = null;
          return true;
        },
        (error: unknown) => {
          const message =
            "无法创建网页：" + (error instanceof Error ? error.message : String(error));
          for (const owner of owners) {
            if (!owner || this.pages.get(owner.id) !== owner || this.layouts.has(owner.id))
              continue;
            owner.layout = undefined;
            owner.syncError = message;
            owner.changed({
              id: owner.id,
              url: owner.url,
              title: "",
              loading: false,
              error: message,
              canBack: false,
              canForward: false,
              focused: false,
            });
          }
          return false;
        },
      )
      .finally(() => {
        this.flight = null;
        if (this.pending) this.schedule();
      });
    return this.flight;
  }
}

/** 观察器只追踪当前可见集合；布局读取和跨进程提交具有独立职责。 */
class WebPageCoordinator implements WebPageHost {
  private readonly pages = new Map<string, PageMount>();
  private readonly hosts = new Map<Element, PageMount>();
  private readonly containers = new Map<HTMLElement, number>();
  private readonly visible = new Set<PageMount>();
  private readonly dirty = new Set<PageMount>();
  private readonly updates: WebPageUpdates;
  private frame = 0;
  private stop: (() => void) | undefined;
  private resize: ResizeObserver | undefined;
  private intersection: IntersectionObserver | undefined;
  private mutations: MutationObserver | undefined;

  constructor(private readonly api: WebPageApi) {
    this.updates = new WebPageUpdates(api, this.pages, this.schedule);
  }

  private readonly sync = (): void => {
    this.frame = 0;
    this.readDirty();
    void this.updates.flush();
  };
  private readonly schedule = (): void => {
    if (!this.frame) this.frame = requestAnimationFrame(this.sync);
  };
  private readonly invalidate = (): void => {
    for (const page of this.visible) this.dirty.add(page);
    if (this.dirty.size > 0) this.schedule();
  };
  private readonly scroll = (event: Event): void => {
    const target = event.target;
    if (
      target === document ||
      (target instanceof Element &&
        [...this.containers.keys()].some((container) => target.contains(container)))
    )
      this.invalidate();
  };

  private readDirty(): void {
    if (this.dirty.size === 0) return;
    const read = viewportRead();
    for (const page of this.dirty) {
      if (this.pages.get(page.id) !== page) continue;
      this.connectContainer(page);
      const next = {
        id: page.id,
        url: page.url,
        ...(page.intersecting ? measure(page.host, read) : { bounds: null, clip: null }),
      };
      if (
        !page.layout ||
        !sameRect(page.layout.bounds, next.bounds) ||
        !sameRect(page.layout.clip, next.clip)
      ) {
        page.layout = next;
        this.updates.layout(next);
      }
    }
    this.dirty.clear();
  }

  private connectContainer(page: PageMount): void {
    const container = page.host.closest<HTMLElement>(".markdown-content");
    if (page.container === container) return;
    if (page.container) this.releaseContainer(page.container);
    page.container = container;
    if (container) {
      const count = this.containers.get(container) ?? 0;
      if (count === 0) this.resize?.observe(container);
      this.containers.set(container, count + 1);
    }
  }

  private releaseContainer(container: HTMLElement): void {
    const count = (this.containers.get(container) ?? 1) - 1;
    if (count === 0) {
      this.containers.delete(container);
      this.resize?.unobserve(container);
    } else this.containers.set(container, count);
  }

  private relevant(record: MutationRecord): boolean {
    const target = record.target;
    if (
      !(target instanceof HTMLElement) ||
      this.hosts.has(target) ||
      target.closest(".webpage-embed")
    )
      return false;
    if (record.type === "attributes")
      return (
        target.matches("dialog, [popover]") ||
        [...this.containers.keys()].some(
          (container) => container.contains(target) || target.contains(container),
        )
      );
    if ([...this.containers.keys()].some((container) => container.contains(target))) return true;
    return [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)].some(
      (node) =>
        node instanceof HTMLElement &&
        (node.matches("dialog, [popover]") || node.querySelector("dialog, [popover]") !== null),
    );
  }

  private listen(): void {
    this.stop = this.api.subscribe((state) => this.pages.get(state.id)?.changed(state));
    this.intersection = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const page = this.hosts.get(entry.target);
        if (!page) continue;
        // NodeView 构造时尚未挂到正文，首次观察回调才有可靠的容器归属。
        this.connectContainer(page);
        if (page.intersecting === entry.isIntersecting) continue;
        page.intersecting = entry.isIntersecting;
        if (page.intersecting) this.visible.add(page);
        else this.visible.delete(page);
        this.dirty.add(page);
      }
      if (this.dirty.size > 0) this.schedule();
    });
    this.resize = new ResizeObserver(this.invalidate);
    this.resize.observe(document.documentElement);
    this.mutations = new MutationObserver((records) => {
      if (records.some((record) => this.relevant(record))) this.invalidate();
    });
    this.mutations.observe(document.body, {
      attributes: true,
      attributeFilter: ["class", "style", "hidden", "inert", "open"],
      childList: true,
      subtree: true,
    });
    document.addEventListener("scroll", this.scroll, true);
    window.addEventListener("resize", this.invalidate);
    document.addEventListener("toggle", this.invalidate, true);
  }

  private unlisten(): void {
    this.stop?.();
    this.stop = undefined;
    this.resize?.disconnect();
    this.resize = undefined;
    this.intersection?.disconnect();
    this.intersection = undefined;
    this.mutations?.disconnect();
    this.mutations = undefined;
    document.removeEventListener("scroll", this.scroll, true);
    window.removeEventListener("resize", this.invalidate);
    document.removeEventListener("toggle", this.invalidate, true);
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  async action(id: string, action: Parameters<WebPageApi["action"]>[1]): Promise<void> {
    const page = this.pages.get(id);
    if (!page) return;
    if (page.syncError) {
      this.dirty.add(page);
      this.readDirty();
      while (this.updates.pending)
        if (!(await this.updates.flush())) throw new Error(page.syncError ?? "网页布局提交失败");
    }
    if (this.pages.get(id) === page) await this.api.action(id, action);
  }

  mount(host: HTMLElement, url: string, changed: (state: WebPageState) => void) {
    if (this.pages.size === 0) this.listen();
    const id = crypto.randomUUID();
    const page: PageMount = {
      id,
      host,
      container: null,
      url,
      changed,
      intersecting: false,
      layout: undefined,
      syncError: null,
    };
    this.pages.set(id, page);
    this.hosts.set(host, page);
    this.intersection?.observe(host);
    this.resize?.observe(host);
    this.connectContainer(page);
    return { id, destroy: () => this.unmount(page) };
  }

  private unmount(page: PageMount): void {
    if (this.pages.get(page.id) !== page) return;
    const { id, host, container } = page;
    this.pages.delete(id);
    this.hosts.delete(host);
    this.visible.delete(page);
    this.dirty.delete(page);
    this.updates.remove(id);
    this.intersection?.unobserve(host);
    this.resize?.unobserve(host);
    if (container) this.releaseContainer(container);
    if (this.pages.size === 0) this.unlisten();
    this.schedule();
  }
}

/**
 * 按可见节点计算布局，仅发送变化；在途 IPC 共用一个队列并合并新布局。
 * @param api 可信主窗口提供的受限网页 API。
 * @returns 挂载、浏览与注销入口；最后一个节点卸载后释放所有监听。
 * @throws 挂载时观察或订阅失败会传播；异步提交失败显示在所属网页，不自动循环重试。
 */
export function createWebPageHost(api: WebPageApi): WebPageHost {
  return new WebPageCoordinator(api);
}
