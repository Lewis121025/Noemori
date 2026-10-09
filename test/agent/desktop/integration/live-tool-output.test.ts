/** @vitest-environment jsdom */
import { flushSync, mount, unmount } from "svelte";
import { fromStore, writable } from "svelte/store";
import { expect, it, onTestFinished, vi } from "vitest";
import LiveToolOutput from "../../../../modules/notes/packages/desktop/src/features/agent/renderer/LiveToolOutput.svelte";
import type { AgentApi, AgentTerminal, TerminalPage } from "../../../../modules/notes/packages/desktop/src/features/agent/shared/api";

const process = { session_id: "process", status: "running" as const, exit_code: null, signal: null, error: null };
const terminal: AgentTerminal = { call_id: "call", process, bytes: 0, tty: false, error: null };
function page(bytes: Uint8Array, offset = 0, more = false): TerminalPage {
  return { process, offset, next_offset: offset + bytes.length, total_bytes: offset + bytes.length, has_more: more,
    chunks: [{ stream: "stdout", data_base64: btoa(String.fromCharCode(...bytes)), offset, next_offset: offset + bytes.length }],
  };
}
function render(read: AgentApi["terminalRead"]) {
  const target = document.createElement("div");
  document.body.append(target);
  const store = writable(terminal), state = fromStore(store);
  const component = mount(LiveToolOutput, { target, props: { api: { terminalRead: read }, session: "conversation",
    get terminal() { return state.current; },
  } });
  let closed = false;
  async function close(): Promise<void> { if (!closed) { closed = true; await unmount(component); target.remove(); } }
  onTestFinished(close);
  flushSync();
  return { target, store, close };
}

it("输出分页按字节游标续读，跨页 UTF-8 字符不损坏，同字节数快照不重复读取", async () => {
  const bytes = new TextEncoder().encode("记录🙂\n");
  const read = vi.fn<AgentApi["terminalRead"]>()
    .mockResolvedValueOnce(page(bytes.slice(0, 8), 0, true))
    .mockResolvedValueOnce(page(bytes.slice(8), 8));
  const { target, store } = render(read);
  await vi.waitFor(() => { flushSync(); expect(target.querySelector("pre")?.textContent).toBe("记录🙂\n"); });
  expect(read.mock.calls.map((call) => call[2])).toEqual(["0", "8"]);
  store.set({ ...terminal, process: { ...process } });
  flushSync();
  expect(read).toHaveBeenCalledTimes(2);
});

it("关闭执行详情后，迟到的日志不会继续写入或请求后续页面", async () => {
  const pending = Promise.withResolvers<TerminalPage>();
  const read = vi.fn<AgentApi["terminalRead"]>(() => pending.promise);
  const { target, close } = render(read);
  expect(read).toHaveBeenCalledWith("conversation", "process", "0");
  await close();
  pending.resolve(page(new TextEncoder().encode("旧会话输出"), 0, true));
  await pending.promise;
  await Promise.resolve();
  expect(read).toHaveBeenCalledOnce();
  expect(target.textContent).toBe("");
});

it("读取失败可以重试，既有输出保留且不会运行任何命令", async () => {
  const read = vi.fn<AgentApi["terminalRead"]>()
    .mockRejectedValueOnce(new Error("日志暂时不可用"))
    .mockResolvedValueOnce(page(new TextEncoder().encode("恢复后的输出")));
  const { target } = render(read);
  await vi.waitFor(() => { flushSync(); expect(target.querySelector('[role="alert"]')?.textContent).toContain("日志暂时不可用"); });
  target.querySelector<HTMLButtonElement>(".read-error button")!.click();
  await vi.waitFor(() => { flushSync(); expect(target.querySelector("pre")?.textContent).toBe("恢复后的输出"); });
  expect(target.querySelector('[role="alert"]')).toBeNull();
  expect(read).toHaveBeenCalledTimes(2);
});
