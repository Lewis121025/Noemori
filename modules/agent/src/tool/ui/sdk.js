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
  class Page {
    constructor(browser, id) {
      this.browser = browser;
      this.id = id;
      this.observation = null;
    }
    async action(action, values = {}) {
      const result = await this.browser.action({ action, page: this.id, ...values });
      if (result.observation) this.observation = result.observation.id;
      else if (!["read", "arm_download", "await_download"].includes(action))
        this.observation = null;
      return result;
    }
    observe() {
      return this.action("observe");
    }
    screenshot() {
      return this.action("screenshot");
    }
    navigate(url) {
      return this.action("navigate", { url });
    }
    back() {
      return this.action("back");
    }
    forward() {
      return this.action("forward");
    }
    reload() {
      return this.action("reload");
    }
    close() {
      return this.action("close");
    }
    read(offset = 0) {
      return this.action("read", { offset });
    }
    find(text, exact = true) {
      return this.action("find", { text, exact });
    }
    wait(text, state = "visible", exact = true) {
      return this.action("wait", { text, state, exact });
    }
    click(ref) {
      return this.action("click", { ref, observation: this.observation });
    }
    fill(ref, text) {
      return this.action("fill", { ref, text, observation: this.observation });
    }
    select(ref, values, by = "label") {
      return this.action("select", { ref, values, by, observation: this.observation });
    }
    check(ref, checked) {
      return this.action("check", { ref, checked, observation: this.observation });
    }
    hover(ref) {
      return this.action("hover", { ref, observation: this.observation });
    }
    press(key, ref) {
      return this.action("press", { key, ...(ref ? { ref } : {}), observation: this.observation });
    }
    type(text, ref) {
      return this.action("type", { text, ...(ref ? { ref } : {}), observation: this.observation });
    }
    scroll(x, y) {
      return this.action("scroll", { x, y, observation: this.observation });
    }
    pointer(x, y, button = "left", clicks = 1) {
      return this.action("pointer", { x, y, button, clicks, observation: this.observation });
    }
    drag(from_x, from_y, to_x, to_y) {
      return this.action("drag", { from_x, from_y, to_x, to_y, observation: this.observation });
    }
    batch(steps) {
      return this.action("batch", { steps, observation: this.observation });
    }
    dialog(accept, text) {
      return this.action("dialog", { accept, ...(text === undefined ? {} : { text }) });
    }
    upload(ref, paths) {
      return this.action("upload", { ref, paths, observation: this.observation });
    }
    chooseFiles(paths) {
      return this.action("choose_files", { paths });
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
    async open(url) {
      const result = await this.action({ action: "open", url });
      if (result.outcome !== "executed") return result;
      const id = result.observation?.page ?? result.tabs.at(-1)?.id;
      const page = this.page(id);
      page.observation = result.observation?.id ?? null;
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
    handoff() {
      return this.action({ action: "handoff" });
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
    }
    async action(action, values = {}) {
      const result = await this.app.action(action, { window: this.id, ...values });
      this.observation = result.observation?.id ?? null;
      return result;
    }
    observe() {
      return this.action("observe");
    }
    screenshot() {
      return this.action("screenshot");
    }
    press(ref) {
      return this.action("ax_action", { ref, name: "AXPress", observation: this.observation });
    }
    setValue(ref, value) {
      return this.action("set_value", { ref, value, observation: this.observation });
    }
    perform(ref, name) {
      return this.action("ax_action", { ref, name, observation: this.observation });
    }
    requestControl(reason) {
      return this.action("request_control", { reason });
    }
    pointer(x, y, button = "left", clicks = 1) {
      return this.action("pointer", { x, y, button, clicks, observation: this.observation });
    }
    drag(from_x, from_y, to_x, to_y) {
      return this.action("drag", { from_x, from_y, to_x, to_y, observation: this.observation });
    }
    type(text) {
      return this.action("type", { text, observation: this.observation });
    }
    key(key) {
      return this.action("key", { key, observation: this.observation });
    }
    scroll(x, y) {
      return this.action("scroll", { x, y, observation: this.observation });
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
    async getApp(id) {
      const app = new App(id);
      app.state = await app.windows();
      if (typeof app.state.app === "string") app.id = app.state.app;
      return app;
    },
  });
  globalThis.console = Object.freeze({ log: print });
})();
