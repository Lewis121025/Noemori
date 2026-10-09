/** @vitest-environment jsdom */
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import NewConversationDialog from "../../../../modules/notes/packages/desktop/src/features/agent/renderer/NewConversationDialog.svelte";
import { emptyUi } from "../../../../modules/notes/packages/desktop/src/features/agent/shared/ui";
import { createAgentApiMock } from "../../../notes/desktop/fixtures/agent-api-mock";

let target: HTMLDivElement;
let component: NewConversationDialog;
let api: ReturnType<typeof createAgentApiMock>;
let created: ReturnType<typeof vi.fn>;
function button(label: string): HTMLButtonElement {
  const result = [...target.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === label,
  );
  if (!result) throw new Error(`缺少按钮：${label}`);
  return result;
}
beforeEach(async () => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  api = createAgentApiMock();
  api.pickWorkspace = vi.fn(async () => null);
  api.create = vi.fn<typeof api.create>(async (workspace, title) => ({
    id: "33333333-3333-4333-8333-333333333333",
    title,
    workspace,
    model: "未选择模型",
    modelSelection: null,
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    origin: null,
    article: null,
    draft: "",
    storageError: null,
    revision: 0,
    closed: false,
    run: null,
    turns: [],
    messages: [],
    approvals: [],
    terminals: [],
    ui: emptyUi(),
    browser: { status: "idle", tabs: [], receipts: [], error: null },
  }));
  created = vi.fn();
  target = document.createElement("div");
  document.body.append(target);
  component = mount(NewConversationDialog, {
    target,
    props: { api, workspaces: [], onCreated: created },
  });
  flushSync();
  await component.open();
  flushSync();
});
afterEach(async () => {
  await unmount(component);
  target.remove();
});

it("没有任何已有目录时可直接创建，关联入口是真实的文件夹选择动作", async () => {
  expect(target.querySelector("select")).toBeNull();
  expect(button("创建对话").disabled).toBe(false);
  button("创建对话").click();
  await vi.waitFor(() => expect(created).toHaveBeenCalledOnce());
  expect(api.create).toHaveBeenCalledWith(null, "新对话");
  expect(api.pickWorkspace).not.toHaveBeenCalled();
});

it("点击关联文件夹会调用系统选择器，取消后仍能创建且保留名称", async () => {
  const title = target.querySelector<HTMLInputElement>("#conversation-title")!;
  title.value = "不依赖目录的讨论";
  title.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
  button("关联文件夹…").click();
  await vi.waitFor(() => {
    flushSync();
    expect(api.pickWorkspace).toHaveBeenCalledOnce();
    expect(button("创建对话").disabled).toBe(false);
  });
  expect(title.value).toBe("不依赖目录的讨论");
  button("创建对话").click();
  await vi.waitFor(() => expect(api.create).toHaveBeenCalledWith(null, "不依赖目录的讨论"));
});

it("选中的目录可取消关联，选择失败会显示原因而不会阻止无关联创建", async () => {
  vi.mocked(api.pickWorkspace)
    .mockResolvedValueOnce("/chosen")
    .mockRejectedValueOnce(new Error("选择器不可用"));
  button("关联文件夹…").click();
  await vi.waitFor(() => {
    flushSync();
    expect(target.textContent).toContain("/chosen");
  });
  button("取消目录关联").click();
  flushSync();
  button("关联文件夹…").click();
  await vi.waitFor(() => {
    flushSync();
    expect(target.querySelector('[role="alert"]')?.textContent).toContain("选择器不可用");
  });
  button("创建对话").click();
  await vi.waitFor(() => expect(api.create).toHaveBeenCalledWith(null, "新对话"));
});

it("从已有目录发起时关联仍可清除，普通新建不继承该目录", async () => {
  await component.open("/context");
  flushSync();
  expect(target.textContent).toContain("/context");
  button("取消目录关联").click();
  flushSync();
  await component.open();
  flushSync();
  expect(target.textContent).not.toContain("/context");
  expect(button("创建对话").disabled).toBe(false);
});
