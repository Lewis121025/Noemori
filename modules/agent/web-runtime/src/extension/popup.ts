import { record } from "../browser/contract.js";

function controls() {
  const status = document.querySelector("#status");
  const session = document.querySelector("#session");
  const list = document.querySelector("#tabs");
  const share = document.querySelector("#share");
  const disconnect = document.querySelector("#unshare");
  const refresh = document.querySelector("#refresh");
  if (
    !(status instanceof HTMLElement) ||
    !(session instanceof HTMLSelectElement) ||
    !(list instanceof HTMLElement) ||
    !(share instanceof HTMLButtonElement) ||
    !(disconnect instanceof HTMLButtonElement) ||
    !(refresh instanceof HTMLButtonElement)
  )
    throw new Error("扩展界面不完整");
  return { status, session, list, share, disconnect, refresh };
}
const { status, session, list, share, disconnect, refresh } = controls();
const popup = chrome.runtime.connect({ name: "noemori-popup" });
window.addEventListener("unload", () => popup.disconnect());

async function update(): Promise<void> {
  const value = record(await chrome.runtime.sendMessage({ type: "refresh" }));
  if (value.error) {
    status.textContent = String(value.error);
    return;
  }
  status.textContent =
    value.connected === true
      ? "已连接 Noemori。请选择会话和允许助手操作的页面。"
      : "请先在 Noemori 中启用浏览器连接，然后重新连接。";
  const sessions = record(value.sessions);
  const selected = session.value;
  session.replaceChildren();
  for (const [id, label] of Object.entries(sessions)) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = String(label);
    session.append(option);
  }
  if (selected in sessions) session.value = selected;
  list.replaceChildren();
  for (const tab of await chrome.tabs.query({ currentWindow: true })) {
    if (tab.id === undefined || !/^https?:/.test(tab.url || "")) continue;
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = String(tab.id);
    label.append(checkbox, document.createTextNode(tab.title || tab.url || "网页"));
    list.append(label);
  }
  share.disabled = value.connected !== true || !session.value;
}
async function action(type: string): Promise<void> {
  share.disabled = true;
  try {
    const tabs = [...list.querySelectorAll('input[type="checkbox"]')]
      .filter((node): node is HTMLInputElement => node instanceof HTMLInputElement && node.checked)
      .map((node) => Number(node.value));
    const value = record(await chrome.runtime.sendMessage({ type, session: session.value, tabs }));
    status.textContent =
      typeof value.error === "string"
        ? value.error
        : type === "share"
          ? "已共享所选页面。关闭此窗口后，助手可以继续操作。"
          : "已释放共享页面。";
  } finally {
    share.disabled = false;
  }
}
share.addEventListener("click", () => {
  void action("share").catch((error: unknown) => {
    status.textContent = error instanceof Error ? error.message : String(error);
  });
});
disconnect.addEventListener("click", () => {
  void action("unshare").catch((error: unknown) => {
    status.textContent = error instanceof Error ? error.message : String(error);
  });
});
refresh.addEventListener("click", () => {
  void update().catch((error: unknown) => {
    status.textContent = error instanceof Error ? error.message : String(error);
  });
});
setTimeout(() => {
  void update().catch((error: unknown) => {
    status.textContent = error instanceof Error ? error.message : String(error);
  });
}, 100);
