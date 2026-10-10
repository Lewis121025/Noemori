// 句柄只封装不透明资源标识；实际授权、版本核验与操作回执仍由 Rust 宿主决定。
(() => {
  const pending = new Set();
  const call = (request) => {
    const work = __rpc(JSON.stringify(request)).then((text) => {
      const value = JSON.parse(text);
      if (value.error && !value.outcome) throw new Error(value.error);
      if (value.sdk) __print(JSON.stringify(value));
      return value;
    });
    pending.add(work);
    work.then(
      () => pending.delete(work),
      () => pending.delete(work),
    );
    return work;
  };
  globalThis.__settle = async () => {
    while (pending.size) await Promise.allSettled([...pending]);
  };
  globalThis.print = (value) => __print(JSON.stringify(value === undefined ? null : value));
  globalThis.emitImage = (value) => __image(typeof value === "string" ? value : value.image);
  // 增量只合并到实际保留的同一基线；更新身份后旧观察不能继续派发引用动作。
  const adoptObservation = (handle, result, preserve = false) => {
    if (result.observation) {
      handle.snapshot = result.observation;
      handle.observation = result.observation.id;
    } else if (result.observation_update) {
      const update = result.observation_update;
      if (update.target !== handle.id || !handle.snapshot || handle.snapshot.id !== update.base || !["delta", "unchanged"].includes(update.kind)) {
        handle.snapshot = null;
        handle.observation = null;
        throw new Error("增量观察缺少匹配基线，请显式完整 observe");
      }
      handle.snapshot = { ...handle.snapshot, ...update.changes, id: update.id };
      handle.observation = update.id;
    } else if (!preserve || !["observed", "executed"].includes(result.outcome)) {
      handle.snapshot = null;
      handle.observation = null;
    }
  };
  const afterOptions = (options) => options.observation_mode === undefined ? {} : { observation_mode: options.observation_mode };
  const observeOptions = (handle, options) => ({
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    ...(options.baseline === undefined && options.mode !== "delta" ? {} : { baseline: options.baseline ?? handle.observation ?? undefined }),
  });
  // 语义句柄只保存类型化查询；执行时由后端唯一解析并绑定真实节点。
  class LocatorScope {
    constructor(page, spec = { chain: [] }) { this.page = page; this.spec = spec; }
    query(kind, value, options = {}) { return new Locator(this.page ?? this, { ...this.spec, chain: [...this.spec.chain, { kind, value, ...options }] }); }
    getByRole(role, options = {}) { return this.query("role", role, options); }
    getByLabel(text, options = {}) { return this.query("label", text, options); }
    getByText(text, options = {}) { return this.query("text", text, options); }
    getByPlaceholder(text, options = {}) { return this.query("placeholder", text, options); }
    getByTestId(value) { return this.query("test_id", value); }
  }
  class Locator extends LocatorScope {
    filter(options) {
      const relative = (locator) => {
        if (!(locator instanceof Locator) || locator.page !== this.page || locator.spec.frame_url !== this.spec.frame_url || JSON.stringify(locator.spec.frames ?? []) !== JSON.stringify(this.spec.frames ?? [])) throw new Error("过滤定位器必须属于同一页面和 iframe");
        return locator.spec.chain;
      };
      const filter = {
        ...(options.hasText === undefined ? {} : { has_text: options.hasText }),
        ...(options.hasNotText === undefined ? {} : { has_not_text: options.hasNotText }),
        ...(options.has === undefined ? {} : { has: relative(options.has) }),
        ...(options.hasNot === undefined ? {} : { has_not: relative(options.hasNot) }),
        ...(options.visible === undefined ? {} : { visible: options.visible }),
      };
      const chain = [...this.spec.chain];
      const last = chain.pop();
      chain.push({ ...last, filter: { ...last.filter, ...filter } });
      return new Locator(this.page, { ...this.spec, chain });
    }
    contentFrame() { return new LocatorScope(this.page, { ...this.spec, chain: [], frames: [...(this.spec.frames ?? []), this.spec.chain] }); }
    action(operation, values = {}, options = {}) { return this.page.action("locator", { locator: this.spec, operation, ...values }, options); }
    click(options = {}) { return this.action("click", {}, options); }
    hover(options = {}) { return this.action("hover", {}, options); }
    fill(text, options = {}) { return this.action("fill", { text }, options); }
    select(values, by = "label", options = {}) { return this.action("select", { values, by }, options); }
    check(checked, options = {}) { return this.action("check", { checked }, options); }
    press(key, options = {}) { return this.action("press", { key }, options); }
    inspect() { return this.action("inspect"); }
    count() { return this.action("count"); }
  }
  class Page extends LocatorScope {
    constructor(browser, id) {
      super(null);
      this.browser = browser;
      this.id = id;
      this.observation = null;
      this.snapshot = null;
      this.capabilities = Object.freeze({
        list: () => this.action("capabilities_list"),
        get: (name) => this.action("capability_get", { name }),
      });
      this.webmcp = Object.freeze({
        list: () => this.action("webmcp_list"),
        call: (directory, tool, input, options = {}) => this.action("webmcp_call", { directory, tool, input }, options),
      });
      this.cdp = Object.freeze({ send: (method, params = {}) => this.action("cdp_send", { method, params }) });
    }
    async action(action, values = {}, options = {}) {
      const result = await this.browser.action({ action, page: this.id, ...values, ...afterOptions(options) });
      adoptObservation(this, result, ["read", "arm_download", "await_download", "capabilities_list", "capability_get", "extension_state", "request_capability", "developer_logs", "webmcp_list", "cdp_send"].includes(action) || action === "locator" && ["inspect", "count"].includes(values.operation));
      return result;
    }
    observe(options = {}) {
      return this.action("observe", observeOptions(this, options));
    }
    handoff(until) {
      this.observation = null;
      this.snapshot = null;
      return this.browser.handoff({ page: this.id, until });
    }
    requestCapability(capability, reason) {
      return this.action("request_capability", { capability, reason });
    }
    logs({ after = 0, limit = 50 } = {}) {
      return this.action("developer_logs", { after, limit });
    }
    screenshot() {
      return this.action("screenshot");
    }
    navigate(url, options = {}) {
      return this.action("navigate", { url }, options);
    }
    back(options = {}) {
      return this.action("back", options);
    }
    forward(options = {}) {
      return this.action("forward", options);
    }
    reload(options = {}) {
      return this.action("reload", options);
    }
    close() {
      return this.action("close");
    }
    read(offset = 0) {
      return this.action("read", { offset });
    }
    find(text, exact = true, options = {}) {
      return this.action("find", { text, exact }, options);
    }
    frameLocator(locator) {
      if (!(locator instanceof Locator) || locator.page !== this) throw new Error("iframe 定位器必须属于当前页面");
      return locator.contentFrame();
    }
    frame({ url }) { return new LocatorScope(this, { chain: [], frame_url: url }); }
    wait(text, state = "visible", exact = true, options = {}) {
      return this.action("wait", { text, state, exact }, options);
    }
    click(ref, options = {}) {
      return this.action("click", { ref, observation: this.observation }, options);
    }
    fill(ref, text, options = {}) {
      return this.action("fill", { ref, text, observation: this.observation }, options);
    }
    select(ref, values, by = "label", options = {}) {
      return this.action("select", { ref, values, by, observation: this.observation }, options);
    }
    check(ref, checked, options = {}) {
      return this.action("check", { ref, checked, observation: this.observation }, options);
    }
    hover(ref, options = {}) {
      return this.action("hover", { ref, observation: this.observation }, options);
    }
    press(key, ref, options = {}) {
      return this.action("press", { key, ...(ref ? { ref } : {}), observation: this.observation }, options);
    }
    type(text, ref, options = {}) {
      return this.action("type", { text, ...(ref ? { ref } : {}), observation: this.observation }, options);
    }
    scroll(x, y, options = {}) {
      return this.action("scroll", { x, y, observation: this.observation }, options);
    }
    pointer(x, y, button = "left", clicks = 1, options = {}) {
      return this.action("pointer", { x, y, button, clicks, observation: this.observation }, options);
    }
    drag(from_x, from_y, to_x, to_y, options = {}) {
      return this.action("drag", { from_x, from_y, to_x, to_y, observation: this.observation }, options);
    }
    batch(steps, options = {}) {
      return this.action("batch", { steps, observation: this.observation }, options);
    }
    dialog(accept, text, options = {}) {
      return this.action("dialog", { accept, ...(text === undefined ? {} : { text }) }, options);
    }
    upload(ref, paths, options = {}) {
      return this.action("upload", { ref, paths, observation: this.observation }, options);
    }
    chooseFiles(paths, options = {}) {
      return this.action("choose_files", { paths }, options);
    }
    async download(action) {
      await this.action("arm_download");
      await action();
      return this.action("await_download");
    }
  }
  class Browser {
    constructor(kind) {
      this.kind = kind;
      this.pages = new Map();
    }
    action(action) {
      return call({ domain: "browser", backend: this.kind, action });
    }
    tabs() {
      return this.action({ action: "tabs" });
    }
    async open(url, options = {}) {
      const result = await this.action({ action: "open", url, ...afterOptions(options) });
      if (result.outcome !== "executed") return result;
      const id = result.page ?? result.observation?.page ?? result.tabs.at(-1)?.id;
      const page = this.page(id);
      adoptObservation(page, result);
      return page;
    }
    page(id) {
      if (typeof id !== "string") throw new Error("页面标识必须来自真实标签页");
      if (!this.pages.has(id)) this.pages.set(id, new Page(this, id));
      return this.pages.get(id);
    }
    requestAccess(origin, reason) {
      return this.action({ action: "request_access", origin, reason });
    }
    downloads() {
      return this.action({ action: "downloads" });
    }
    saveDownload(id, path) {
      return this.action({ action: "save_download", id, path });
    }
    handoff(completion) {
      return this.action({ action: "handoff", ...(completion === undefined ? {} : { completion }) });
    }
  }
  const browsers = new Map();
  globalThis.browser = Object.freeze({
    async get(kind) {
      if (!["managed", "chrome", "edge"].includes(kind))
        throw new Error("浏览器类型必须是 managed、chrome 或 edge");
      if (!browsers.has(kind)) browsers.set(kind, new Browser(kind));
      const value = browsers.get(kind);
      value.state = await value.tabs();
      return value;
    },
  });
  class Window {
    constructor(app, id) {
      this.app = app;
      this.id = id;
      this.observation = null;
      this.snapshot = null;
    }
    async action(action, values = {}, options = {}) {
      const result = await this.app.action(action, { window: this.id, ...values, ...afterOptions(options) });
      adoptObservation(this, result);
      return result;
    }
    observe(options = {}) {
      return this.action("observe", observeOptions(this, options));
    }
    screenshot() {
      return this.action("screenshot");
    }
    press(ref, options = {}) {
      return this.action("ax_action", { ref, name: "AXPress", observation: this.observation }, options);
    }
    setValue(ref, value, options = {}) {
      return this.action("set_value", { ref, value, observation: this.observation }, options);
    }
    selectText(ref, text, selection = {}, options = {}) {
      return this.action("select_text", { ref, text, ...selection, observation: this.observation }, options);
    }
    paste(ref, text, formats = {}, options = {}) {
      return this.action("paste", { ref, text, ...formats, observation: this.observation }, options);
    }
    perform(ref, name, options = {}) {
      return this.action("ax_action", { ref, name, observation: this.observation }, options);
    }
    requestControl(reason) {
      return this.action("request_control", { reason });
    }
    pointer(x, y, button = "left", clicks = 1, options = {}) {
      return this.action("pointer", { x, y, button, clicks, observation: this.observation }, options);
    }
    drag(from_x, from_y, to_x, to_y, options = {}) {
      return this.action("drag", { from_x, from_y, to_x, to_y, observation: this.observation }, options);
    }
    type(text, options = {}) {
      return this.action("type", { text, observation: this.observation }, options);
    }
    key(key, options = {}) {
      return this.action("key", { key, observation: this.observation }, options);
    }
    scroll(x, y, options = {}) {
      return this.action("scroll", { x, y, observation: this.observation }, options);
    }
  }
  class App {
    constructor(id) {
      this.id = id;
    }
    action(action, values = {}) {
      return call({ domain: "computer", action: { action, app: this.id, ...values } });
    }
    windows() {
      return this.action("windows");
    }
    window(id) {
      return new Window(this, id);
    }
    handoff() {
      return this.action("handoff");
    }
  }
  globalThis.computer = Object.freeze({
    permissions() {
      return call({ domain: "computer", action: { action: "permissions" } });
    },
    apps() {
      return call({ domain: "computer", action: { action: "apps" } });
    },
    launchApp(bundle_id, reason) {
      return call({ domain: "computer", action: { action: "launch_app", bundle_id, reason } });
    },
    async getApp(id) {
      const app = new App(id);
      app.state = await app.windows();
      if (typeof app.state.app === "string") app.id = app.state.app;
      return app;
    },
  });
  globalThis.console = Object.freeze({ log: print });
})();
