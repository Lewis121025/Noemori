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

it("返回会话只退出模型设置，关闭助手才退出整个面板", async () => {
  button("模型接口").click();
  await vi.waitFor(() => {
    flushSync();
    expect(target.querySelector(".model-settings")).not.toBeNull();
  });
  button("返回会话").click();
  flushSync();
  expect(target.querySelector(".model-settings")).toBeNull();
  expect(close).not.toHaveBeenCalled();
  button("＋ 新会话");
  button("模型接口").click();
  flushSync();
  button("关闭助手").click();
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
});

async function editProvider(): Promise<HTMLInputElement> {
  button("模型接口").click();
  await vi.waitFor(() => {
    flushSync();
    expect(target.textContent).not.toContain("正在加载供应商");
    expect(target.querySelector(".model-settings")).not.toBeNull();
  });
  button("＋ 添加供应商").click();
  flushSync();
  const field = [...target.querySelectorAll("input")].find(
    (item) => item.closest("label")?.textContent?.trim() === "名称",
  );
  if (!field) throw new Error("没有名称输入");
  field.value = "尚未保存的连接";
  field.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
  return field;
}

it.each(["返回会话", "关闭助手"])("%s必须经过供应商草稿的离开确认", async (label) => {
  const field = await editProvider();
  button(label).click();
  await vi.waitFor(() => {
    flushSync();
    expect(target.textContent).toContain("当前修改尚未保存");
  });
  button("继续编辑").click();
  flushSync();
  expect(field.value).toBe("尚未保存的连接");
  expect(close).not.toHaveBeenCalled();
  await vi.waitFor(() => {
    flushSync();
    expect(button(label).disabled).toBe(false);
  });
  button(label).click();
  await vi.waitFor(() => {
    flushSync();
    expect(target.textContent).toContain("当前修改尚未保存");
  });
  button("放弃修改").click();
  await vi.waitFor(() => {
    flushSync();
    if (label === "返回会话") expect(target.querySelector(".model-settings")).toBeNull();
    else expect(close).toHaveBeenCalledOnce();
  });
});
