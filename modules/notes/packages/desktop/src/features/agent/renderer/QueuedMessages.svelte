<script lang="ts">
  import { readConversationInput } from "../shared/input";
  import type { ConversationQueue } from "../shared/queue";
  let {
    queue,
    disabled,
    onRemove,
    onPause,
  }: {
    queue: ConversationQueue;
    disabled: boolean;
    onRemove: (id: string) => Promise<void>;
    onPause: (paused: boolean) => Promise<void>;
  } = $props();
  let busy = $state(false);
  let error = $state("");
  async function change(action: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = true;
    error = "";
    try {
      await action();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }
</script>

{#if queue.messages.length}
  <section class="queue" aria-label="追问队列">
    <header>
      <span>待发送 <span class="count">{queue.messages.length}</span></span>
      {#if queue.paused}<span class="state">已暂停</span>{/if}
      <button
        type="button"
        disabled={disabled || busy}
        onclick={() => void change(() => onPause(!queue.paused))}
      >
        {queue.paused ? "继续队列" : "暂停队列"}
      </button>
    </header>
    <ol>
      {#each queue.messages as message (message.id)}
        {@const input = readConversationInput(message.text)}
        {@const label = input.text || input.attachments.map((file) => file.name).join("、")}
        <li>
          <span title={label}>{label}</span>
          {#if input.references.length}<small>{input.references.length} 条引用</small>{/if}
          {#if input.attachments.length}<small>{input.attachments.length} 个附件</small>{/if}
          {#if message.state === "sending"}<small>{queue.paused ? "发送待确认" : "正在发送"}</small
            >{/if}
          <button
            type="button"
            aria-label="移除追问"
            title="移除这条追问"
            disabled={disabled || busy || (message.state === "sending" && !queue.paused)}
            onclick={() => void change(() => onRemove(message.id))}
            ><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg
            ></button
          >
        </li>
      {/each}
    </ol>
    {#if error || queue.error}<p role="alert">{error || queue.error}</p>{/if}
  </section>
{/if}

<style>
  .queue {
    flex: 0 0 auto;
    align-self: center;
    width: calc(100% - 2 * var(--conversation-inset, 20px));
    max-width: var(--conversation-width, 44rem);
    margin: 8px var(--conversation-inset, 20px) 0;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--bg);
    font-size: 12px;
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    color: var(--muted);
  }
  header > button {
    margin-left: auto;
  }
  .count {
    margin-left: 4px;
    font-variant-numeric: tabular-nums;
  }
  .state {
    font-size: 10px;
  }
  button {
    border: 0;
    padding: 3px 5px;
    border-radius: var(--radius-control);
    background: transparent;
    color: var(--muted);
    font: inherit;
    cursor: pointer;
    transition:
      background var(--motion-fast) var(--motion-ease),
      color var(--motion-fast) var(--motion-ease);
  }
  button:hover:not(:disabled) {
    background: var(--control-hover, var(--selected));
    color: var(--fg);
  }
  button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  ol {
    margin: 0;
    padding: 0 12px 6px;
    list-style: none;
    max-height: 100px;
    overflow: auto;
  }
  li {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 28px;
  }
  li > span {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  li > button {
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    padding: 0;
    flex-shrink: 0;
  }
  svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
  }
  small {
    color: var(--muted);
  }
  p {
    margin: 0;
    padding: 0 12px 8px;
    color: var(--danger);
    overflow-wrap: anywhere;
    line-height: 1.5;
  }
  @media (max-height: 560px) {
    ol {
      max-height: 28px;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    button {
      transition: none;
    }
  }
</style>
