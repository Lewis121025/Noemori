/** @vitest-environment jsdom */
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import AgentPanel from "../../../../modules/notes/packages/desktop/src/features/agent/renderer/AgentPanel.svelte";
import { createAgentApiMock } from "../../../notes/desktop/fixtures/agent-api-mock";

let target: HTMLDivElement;
let panel: AgentPanel;
let close: ReturnType<typeof vi.fn>;

function button(label: string): HTMLButtonElement {
  const found = [...target.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === label || item.getAttribute("aria-label") === label,
  );
  if (!found) throw new Error(`缺少按钮：${label}`);
  return found;
}

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  target = document.createElement("div");
  document.body.append(target);
  close = vi.fn();
  panel = mount(AgentPanel, {
    target,
    props: { api: createAgentApiMock(), close, openLink: async () => {} },
  });
  flushSync();
});

afterEach(async () => {
  await unmount(panel);
  target.remove();
});

it("助手不再包含独立模型配置页，关闭时仍经过保存门禁", async () => {
  expect(target.querySelector('[aria-label="模型接口"]')).toBeNull();
  expect(target.querySelector(".model-settings")).toBeNull();
  button("开始新对话");
  button("关闭助手").click();
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
});

it("缺少模型时仍可打开新建对话，不强制进入配置", async () => {
  button("开始新对话").click();
  await vi.waitFor(() => {
    flushSync();
    expect(target.querySelector(".new-conversation-dialog[open]")).not.toBeNull();
  });
  expect(target.querySelector(".panel-error")).toBeNull();
  expect(target.querySelector(".model-settings")).toBeNull();
});
