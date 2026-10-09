import { NativeBridge } from "./bridge.js";
import { ExtensionBrowser } from "./browser.js";
import { chromeTransport } from "./transport.js";
import { record } from "../browser/contract.js";

let connection: string | null = null;
let sessions: Record<string, unknown> = {};
let error: string | null = null;
const popups = new Set<chrome.runtime.Port>();
const browsers = new Map<string, ExtensionBrowser>();
const active = new Map<string, { session: string; abort: AbortController }>();

function pause(reason: string): void {
  error = reason;
  for (const call of active.values()) call.abort.abort();
  for (const browser of browsers.values()) {
    browser.cancel();
    void browser.close().catch((failure: unknown) => {
      error = failure instanceof Error ? failure.message : String(failure);
    });
  }
  browsers.clear();
  connection = null;
  sessions = {};
}

const bridge = new NativeBridge(async (frame) => {
  if (frame.type === "welcome" || frame.type === "sessions") {
    sessions = record(frame.sessions);
    if (frame.type === "welcome") {
      if (typeof frame.connection !== "string") throw new Error("连接身份无效");
      connection = frame.connection;
      error = null;
      if (popups.size) bridge.send({ type: "ui_lock", active: true });
    }
    return;
  }
  if (frame.type === "invalidate") {
    for (const browser of browsers.values())
      if (frame.session === "*" || frame.session === browser.session) browser.invalidate();
    return;
  }
  if (frame.type === "cancel") {
    if (typeof frame.id === "string") active.get(frame.id)?.abort.abort();
    if (typeof frame.session === "string") browsers.get(frame.session)?.cancel();
    return;
  }
  if (frame.type === "release") {
    if (typeof frame.session !== "string") throw new Error("释放缺少会话身份");
    for (const call of active.values()) if (call.session === frame.session) call.abort.abort();
    const browser = browsers.get(frame.session);
    if (browser) {
      await browser.close();
      browsers.delete(frame.session);
    }
    if (typeof frame.id === "string")
      bridge.send({ type: "result", id: frame.id, value: { outcome: "executed", mode: "human" } });
    return;
  }
  if (
    frame.type !== "call" ||
    frame.version !== 1 ||
    typeof frame.id !== "string" ||
    typeof frame.session !== "string" ||
    typeof frame.timeout_ms !== "number" ||
    typeof frame.expires_at !== "number"
  )
    throw new Error("控制消息字段无效");
  const id = frame.id;
  const session = frame.session;
  if (active.has(id)) throw new Error("重复的未结算操作标识");
  const browser = browsers.get(session);
  if (!browser) {
    bridge.send({
      type: "result",
      id,
      value: { outcome: "not_executed", error: "会话没有由用户共享的标签页" },
    });
    return;
  }
  const abort = new AbortController();
  active.set(id, { session, abort });
  const timeout = Math.min(frame.timeout_ms, frame.expires_at - Date.now());
  const timer = setTimeout(() => abort.abort(), Math.max(0, timeout));
  try {
    const value =
      timeout > 0
        ? await browser.execute(frame.action, abort.signal, timeout)
        : { outcome: "not_executed", error: "控制消息到达时预算已耗尽" };
    bridge.send({ type: "result", id, value });
  } finally {
    clearTimeout(timer);
    active.delete(id);
  }
}, pause);

function owner(tab: number): ExtensionBrowser | undefined {
  return [...browsers.values()].find((browser) => browser.owns(tab));
}
function publish(session: string, tabs: unknown[]): void {
  bridge.send({ type: "share", session, tabs });
}

chrome.debugger.onEvent.addListener((source, method, raw: unknown) => {
  if (source.tabId === undefined) return;
  const browser = owner(source.tabId);
  if (!browser) return;
  void browser.event(source, method, record(raw)).catch((failure: unknown) => {
    for (const call of active.values()) if (call.session === browser.session) call.abort.abort();
    browser.cancel();
    error = failure instanceof Error ? failure.message : String(failure);
    bridge.send({ type: "event", event: "human", session: browser.session });
  });
});
chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === undefined) return;
  const browser = owner(source.tabId);
  if (!browser) return;
  browser.lost(source.tabId, reason === "target_closed");
  if (reason !== "target_closed") {
    for (const call of active.values()) if (call.session === browser.session) call.abort.abort();
    bridge.send({ type: "event", event: "human", session: browser.session });
  }
});
chrome.tabs.onRemoved.addListener((tab) => owner(tab)?.lost(tab, true));
chrome.windows.onRemoved.addListener((window) => {
  for (const browser of browsers.values()) browser.windowClosed(window);
});
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id === undefined || tab.openerTabId === undefined) return;
  const browser = owner(tab.openerTabId);
  if (browser)
    void browser.share(tab.id).catch((failure: unknown) => {
      error = failure instanceof Error ? failure.message : String(failure);
    });
});

/** 只有扩展自身 popup 才能共享页面；没有 content script 或 externally_connectable 接入。 */
chrome.runtime.onMessage.addListener((raw: unknown, sender, reply) => {
  if (
    sender.id !== chrome.runtime.id ||
    sender.url !== chrome.runtime.getURL("extension/popup.html")
  )
    return false;
  const work = async (): Promise<unknown> => {
    const value = record(raw);
    if (value.type === "connect") {
      bridge.connect();
      return { connected: connection !== null };
    }
    if (value.type === "refresh") {
      if (connection) bridge.send({ type: "sessions" });
      return { connected: connection !== null, sessions, error };
    }
    if (value.type === "share") {
      if (
        !connection ||
        typeof value.session !== "string" ||
        !(value.session in sessions) ||
        !Array.isArray(value.tabs) ||
        !value.tabs.every((tab: unknown) => typeof tab === "number" && Number.isSafeInteger(tab))
      )
        throw new Error("共享会话或标签页无效");
      let browser = browsers.get(value.session);
      if (!browser) {
        browser = new ExtensionBrowser(value.session, connection, chromeTransport, bridge, publish);
        browsers.set(value.session, browser);
      }
      for (const tab of value.tabs) {
        const existing = owner(tab);
        if (existing && existing !== browser) throw new Error("标签页已被另一会话控制");
        const state = await chrome.tabs.get(tab);
        if (!/^https?:/.test(state.url || "")) throw new Error("只支持共享 HTTP(S) 页面");
        await browser.share(tab);
      }
      return { shared: true };
    }
    if (value.type === "unshare") {
      if (typeof value.session !== "string") throw new Error("缺少会话");
      const browser = browsers.get(value.session);
      if (browser) {
        await browser.close();
        browsers.delete(value.session);
        publish(value.session, []);
      }
      return { shared: false };
    }
    throw new Error("不支持的扩展 UI 请求");
  };
  void work().then(reply, (error: unknown) =>
    reply({ error: error instanceof Error ? error.message : String(error) }),
  );
  return true;
});
chrome.runtime.onConnect.addListener((port) => {
  if (
    port.name !== "noemori-popup" ||
    port.sender?.url !== chrome.runtime.getURL("extension/popup.html")
  )
    return;
  popups.add(port);
  bridge.connect();
  if (connection) bridge.send({ type: "ui_lock", active: true });
  port.onDisconnect.addListener(() => {
    popups.delete(port);
    if (connection) bridge.send({ type: "ui_lock", active: popups.size > 0 });
  });
});
