/** @vitest-environment jsdom */
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import CreateEntryDialog from "@reader/renderer/library/CreateEntryDialog.svelte";
import { ReaderWorkspaceController } from "@reader/renderer/workspace/state.svelte";
import { createReaderApiMock } from "../../fixtures/reader-api-mock";

let target: HTMLDivElement;
let component: CreateEntryDialog;
let workspace: ReaderWorkspaceController;
let api: ReturnType<typeof createReaderApiMock>;
let completed: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  api = createReaderApiMock({
    vaultEntries: vi.fn(async () => [
      { path: "项目", kind: "directory" },
      { path: "归档", kind: "directory" },
      { path: "归档/计划.md", kind: "file" },
    ]),
  });
  workspace = new ReaderWorkspaceController(api);
  await workspace.restore();
  target = document.createElement("div");
  document.body.append(target);
  completed = vi.fn();
  component = mount(CreateEntryDialog, { target, props: { workspace, onComplete: completed } });
  flushSync();
  const dialog = target.querySelector("dialog")!;
  dialog.showModal = () => {
    dialog.open = true;
  };
});

afterEach(async () => {
  await unmount(component);
  for (const pane of workspace.panes) pane.dispose();
  target.remove();
  vi.restoreAllMocks();
});

function name(value: string): void {
  const input = target.querySelector<HTMLInputElement>('[aria-label="名称"]')!;
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
}
function directory(path: string): void {
  [...target.querySelectorAll<HTMLElement>('[role="option"]')]
    .find((item) => item.title === path)!
    .click();
  flushSync();
}
function submit(): void {
  target
    .querySelector("form")!
    .dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
  flushSync();
}

it.each(["note", "whiteboard", "directory"] as const)(
  "%s 确认前不写文件，名称与目标目录决定实际路径",
  async (kind) => {
    await component.open(kind, "项目");
    flushSync();
    expect(api.entryCreate).not.toHaveBeenCalled();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("名称");
    name("整理");
    directory("归档");
    submit();
    const path = `归档/整理${kind === "note" ? ".md" : kind === "whiteboard" ? ".noemoriboard" : ""}`;
    await vi.waitFor(() =>
      expect(completed).toHaveBeenCalledWith({
        action: "create",
        entry: { path, kind: kind === "directory" ? "directory" : "file" },
      }),
    );
    expect(api.entryCreate).toHaveBeenCalledTimes(1);
    const [created, type, initial] = vi.mocked(api.entryCreate).mock.calls[0]!;
    expect(created).toBe(path);
    expect(type).toBe(kind === "directory" ? "directory" : "file");
    if (kind === "whiteboard")
      expect(JSON.parse(new TextDecoder().decode(initial))).toEqual({ version: 2, strokes: [] });
  },
);

it("同名或目标消失时禁止创建，取消不遗留文件", async () => {
  await component.open("note", "项目");
  flushSync();
  name("计划");
  directory("归档");
  expect(target.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(true);
  submit();
  expect(api.entryCreate).not.toHaveBeenCalled();
  name("新计划");
  vi.mocked(api.vaultEntries).mockResolvedValue([]);
  await workspace.refreshList();
  flushSync();
  expect(target.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(true);
  [...target.querySelectorAll("button")]
    .find((item) => item.textContent?.trim() === "取消")!
    .click();
  expect(target.querySelector("dialog")!.open).toBe(false);
  expect(api.entryCreate).not.toHaveBeenCalled();
});

it("写入失败保留名称和目录，重试仍写入用户确认的位置", async () => {
  vi.mocked(api.entryCreate).mockRejectedValueOnce(new Error("磁盘暂不可写"));
  await component.open("note", "项目");
  flushSync();
  name("草稿");
  directory("归档");
  submit();
  await vi.waitFor(() =>
    expect(target.querySelector('[role="alert"]')?.textContent).toContain("磁盘暂不可写"),
  );
  expect(target.querySelector("dialog")!.open).toBe(true);
  expect(target.querySelector<HTMLInputElement>('[aria-label="名称"]')!.value).toBe("草稿");
  submit();
  await vi.waitFor(() => expect(completed).toHaveBeenCalledOnce());
  expect(vi.mocked(api.entryCreate).mock.calls.map((call) => call[0])).toEqual([
    "归档/草稿.md",
    "归档/草稿.md",
  ]);
});
