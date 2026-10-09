<script lang="ts">
  import type { AgentApi, AgentTerminal as TerminalInfo } from "../shared/api";
  import AgentTerminal from "./AgentTerminal.svelte";
  let {
    api,
    session,
    terminals,
    archived,
    onCreate,
    onHide,
  }: {
    api: AgentApi;
    session: string;
    terminals: TerminalInfo[];
    archived: boolean;
    onCreate: () => Promise<void>;
    onHide: () => void;
  } = $props();
  let selected = $state<string | null>(null);
  let creating = $state(false);
  let height = $state(220);
  let drawer: HTMLElement;
  let drag = $state<{ y: number; height: number; pointer: number } | null>(null);
  const terminal = $derived(
    terminals.find((item) => item.process.session_id === selected) ?? terminals.at(-1),
  );
  async function create(): Promise<void> {
    creating = true;
    try {
      await onCreate();
      selected = terminals.at(-1)?.process.session_id ?? null;
    } finally {
      creating = false;
    }
  }
  function resize(value: number): void {
    const limit = (drawer.parentElement?.clientHeight ?? 600) * 0.3;
    height = Math.max(100, Math.min(value, limit));
  }
</script>

<section
  class="terminal-drawer"
  aria-label="会话终端"
  bind:this={drawer}
  style:height={`${height}px`}
>
  <button
    type="button"
    class="resize-handle"
    aria-label="调整终端高度"
    title={`${height}px · 拖动或按 ↑ ↓ 调整`}
    onpointerdown={(event) => {
      if (event.button !== 0 || drag) return;
      event.preventDefault();
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag = { y: event.clientY, height: drawer.clientHeight, pointer: event.pointerId };
    }}
    onpointermove={(event) => {
      if (drag?.pointer === event.pointerId) resize(drag.height + drag.y - event.clientY);
    }}
    onpointerup={(event) => {
      if (drag?.pointer === event.pointerId) drag = null;
    }}
    onpointercancel={(event) => {
      if (drag?.pointer === event.pointerId) drag = null;
    }}
    onkeydown={(event) => {
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        resize(drawer.clientHeight + (event.key === "ArrowUp" ? 24 : -24));
      }
    }}
  ></button>
  <header>
    <span class="heading">终端</span>
    <div class="tabs" role="tablist" aria-label="会话终端列表">
      {#each terminals as item, index (item.process.session_id)}
        <button
          type="button"
          role="tab"
          aria-selected={terminal?.process.session_id === item.process.session_id}
          title={item.process.status === "running" ? "运行中" : "已结束"}
          onclick={() => (selected = item.process.session_id)}
        >
          <span class:running={item.process.status === "running"} class="dot"></span>{index + 1}
        </button>
      {/each}
    </div>
    <button
      class="icon"
      type="button"
      aria-label="新终端"
      title="新终端"
      disabled={archived || creating}
      onclick={() => void create()}>+</button
    >
    <button
      class="icon"
      type="button"
      aria-label="收起终端"
      title="收起终端 · Ctrl+`"
      onclick={onHide}>⌄</button
    >
  </header>
  {#if terminal}
    {#key `${session}:${terminal.process.session_id}`}<AgentTerminal
        {api}
        {session}
        {terminal}
      />{/key}
  {:else}
    <div class="empty">
      <span>在此对话中运行命令</span><button
        type="button"
        disabled={archived || creating}
        onclick={() => void create()}>打开终端</button
      >
    </div>
  {/if}
</section>

<style>
  .terminal-drawer {
    display: flex;
    flex-direction: column;
    flex: 0 1 auto;
    min-height: 100px;
    /* 终端与队列同时打开时，小窗口仍须留出消息阅读和输入的空间。 */
    max-height: min(30%, calc(100% - 330px));
    border-top: 1px solid var(--border);
    background: var(--bg);
    position: relative;
    overflow: hidden;
  }
  .resize-handle {
    position: absolute;
    inset: 0 0 auto;
    height: 5px;
    width: 100%;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    cursor: row-resize;
    touch-action: none;
    z-index: 1;
  }
  .resize-handle:hover,
  .resize-handle:focus-visible {
    background: var(--selected);
    outline: 1px solid var(--accent);
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 34px;
    padding: 4px 10px 0;
    font-size: 11px;
    flex: 0 0 auto;
  }
  .heading {
    color: var(--muted);
  }
  .tabs {
    display: flex;
    flex: 1;
    min-width: 0;
    overflow-x: auto;
    gap: 4px;
  }
  button {
    border: 0;
    border-radius: 5px;
    padding: 4px 8px;
    color: var(--muted);
    background: transparent;
    font: inherit;
    cursor: pointer;
  }
  button:hover,
  button[aria-selected="true"] {
    background: var(--selected);
    color: var(--fg);
  }
  button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  [role="tab"] {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    flex-shrink: 0;
  }
  .dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--muted);
    opacity: 0.4;
  }
  .dot.running {
    background: var(--accent);
    opacity: 1;
  }
  .icon {
    flex-shrink: 0;
    font-size: 17px;
    min-width: 26px;
  }
  .empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    color: var(--muted);
    font-size: 12px;
  }
  .empty button {
    border: 1px solid var(--border);
  }
</style>
