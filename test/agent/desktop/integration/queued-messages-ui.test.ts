/** @vitest-environment jsdom */
import { flushSync, mount, unmount } from "svelte";
import { expect, it, onTestFinished, vi } from "vitest";
import QueuedMessages from "../../../../modules/notes/packages/desktop/src/features/agent/renderer/QueuedMessages.svelte";
import type { ConversationQueue } from "../../../../modules/notes/packages/desktop/src/features/agent/shared/queue";

it.each([false, true])(
  "发送中的追问不能移除，恢复后的未确认项可核对后移除：暂停=%s",
  async (paused) => {
    const target = document.createElement("div");
    document.body.append(target);
    const queue: ConversationQueue = {
      messages: [{ id: "pending", text: "原追问", state: "sending" }],
      paused,
      error: paused ? "请核对上次发送状态" : null,
    };
    const onRemove = vi.fn(async (_id: string) => {});
    const component = mount(QueuedMessages, {
      target,
      props: {
        queue,
        disabled: false,
        onRemove,
        onPause: async () => {},
      },
    });
    onTestFinished(async () => {
      await unmount(component);
      target.remove();
    });
    flushSync();
    expect(target.textContent).toContain(paused ? "发送待确认" : "正在发送");
    const remove = target.querySelector<HTMLButtonElement>('[aria-label="移除追问"]')!;
    expect(remove.disabled).toBe(!paused);
    remove.click();
    if (paused) await vi.waitFor(() => expect(onRemove).toHaveBeenCalledWith("pending"));
    else expect(onRemove).not.toHaveBeenCalled();
  },
);
