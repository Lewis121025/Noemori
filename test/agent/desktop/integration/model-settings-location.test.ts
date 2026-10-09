/** @vitest-environment jsdom */
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "../../../../modules/notes/packages/desktop/src/renderer/App.svelte";
import { createReaderApiMock } from "../../../notes/desktop/fixtures/reader-api-mock";
import { createAppApiMock } from "../../../notes/desktop/fixtures/app-api-mock";
import { createAgentApiMock } from "../../../notes/desktop/fixtures/agent-api-mock";
import type { AppCommand } from "../../../../modules/notes/packages/desktop/src/shared/api";

let component: ReturnType<typeof mount>;
let target: HTMLDivElement;
let command: (value: AppCommand) => void;
let requestClose: () => void;
let app: ReturnType<typeof createAppApiMock>;

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  app = createAppApiMock({
    subscribeCommand: (callback) => {
      command = callback;
      return () => {};
    },
    subscribeFlushBeforeClose: (callback) => {
      requestClose = callback;
      return () => {};
    },
    closeAfterFlush: vi.fn(async () => {}),
    closeBlocked: vi.fn(async () => {}),
  });
  window.noemori = { app, reader: createReaderApiMock(), agent: createAgentApiMock() };
  target = document.createElement("div");
  document.body.append(target);
  component = mount(App, { target });
  flushSync();
});
afterEach(async () => {
  await unmount(component);
  target.remove();
});

function button(label: string, scope: ParentNode = target): HTMLButtonElement {
  const found = [...scope.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === label || item.getAttribute("aria-label") === label,
  );
  if (!found) throw new Error(`缺少按钮：${label}`);
  return found;
}
async function models(): Promise<HTMLDialogElement> {
  await vi.waitFor(() => {
    flushSync();
    expect(button("设置").disabled).toBe(false);
  });
  const dialog = target.querySelector<HTMLDialogElement>(".settings-window")!;
  await vi.waitFor(() => {
    command("open-settings");
    flushSync();
    expect(dialog.open).toBe(true);
  });
  button("LLM", dialog).click();
  await vi.waitFor(() => {
    flushSync();
    expect(dialog.querySelector(".model-settings")).not.toBeNull();
  });
  return dialog;
}
async function edit(): Promise<HTMLDialogElement> {
  const dialog = await models();
  await vi.waitFor(() => {
    flushSync();
    expect(dialog.textContent).not.toContain("正在加载供应商");
  });
  button("高级设置", dialog).click();
  flushSync();
  const name = [...dialog.querySelectorAll("input")].find(
    (item) => item.closest("label")?.textContent?.trim() === "名称",
  )!;
  name.value = "未保存的供应商";
  name.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
  return dialog;
}

it("LLM 配置只出现在统一设置，助手不拥有独立配置页", async () => {
  const dialog = await models();
  expect(dialog.open).toBe(true);
  button("工作区助手").click();
  flushSync();
  expect(target.querySelector(".agent-panel .model-settings")).toBeNull();
  expect(target.querySelector('.agent-panel [aria-label="模型接口"]')).toBeNull();
});

it.each(["关闭设置", "外观与阅读", "Esc"])(
  "%s 会确认 LLM 配置草稿，取消后保留表单",
  async (label) => {
    const dialog = await edit();
    const leave = () => {
      if (label === "Esc") dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
      else button(label, dialog).click();
    };
    leave();
    await vi.waitFor(() => {
      flushSync();
      expect(dialog.textContent).toContain("当前修改尚未保存");
    });
    button("继续编辑", dialog).click();
    flushSync();
    expect(dialog.open).toBe(true);
    expect(dialog.querySelector<HTMLInputElement>('input[maxlength="128"]')?.value).toBe(
      "未保存的供应商",
    );
    await vi.waitFor(() => {
      flushSync();
      expect(button("关闭设置", dialog).disabled).toBe(false);
    });
    leave();
    await vi.waitFor(() => {
      flushSync();
      expect(dialog.textContent).toContain("当前修改尚未保存");
    });
    button("放弃修改", dialog).click();
    await vi.waitFor(() => {
      flushSync();
      if (label === "外观与阅读")
        expect(button(label, dialog).getAttribute("aria-pressed")).toBe("true");
      else expect(dialog.open).toBe(false);
    });
  },
);

it("应用关闭也经过统一设置的配置草稿确认", async () => {
  const dialog = await edit();
  requestClose();
  await vi.waitFor(() => {
    flushSync();
    expect(dialog.textContent).toContain("当前修改尚未保存");
  });
  button("继续编辑", dialog).click();
  await vi.waitFor(() => expect(app.closeBlocked).toHaveBeenCalledOnce());
  expect(app.closeAfterFlush).not.toHaveBeenCalled();
});
