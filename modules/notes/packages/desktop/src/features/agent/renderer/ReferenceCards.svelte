<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import { fly } from "svelte/transition";
  import type { AgentReference } from "../shared/references";
  let {
    references,
    disabled = false,
    onRemove,
    onOpen,
  }: {
    references: AgentReference[];
    disabled?: boolean;
    onRemove?: (id: string) => void;
    onOpen?: (reference: AgentReference) => Promise<void>;
  } = $props();
  let preview = $state<AgentReference | null>(null);
  let dialog: HTMLDialogElement;
  let error = $state("");
  let opening = $state(false);
  const media =
    typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
  let reduced = $state(media?.matches ?? true);
  const changed = () => {
    reduced = media?.matches ?? true;
  };
  media?.addEventListener("change", changed);
  onDestroy(() => media?.removeEventListener("change", changed));
  const name = (reference: AgentReference) =>
    reference.source?.path.split("/").at(-1) ?? "选中文字";
  async function show(reference: AgentReference): Promise<void> {
    preview = reference;
    error = "";
    await tick();
    dialog.showModal();
  }
  async function openSource(): Promise<void> {
    if (!preview || !onOpen || opening) return;
    opening = true;
    error = "";
    const reference = preview;
    dialog.close();
    try {
      await onOpen(reference);
    } catch (cause) {
      preview = reference;
      error = cause instanceof Error ? cause.message : String(cause);
      await tick();
      dialog.showModal();
    } finally {
      opening = false;
    }
  }
</script>

{#if references.length}<ul class="references" aria-label="引用内容">
    {#each references as reference (reference.id)}<li
        transition:fly={{ y: 5, duration: reduced ? 0 : 140 }}
      >
        <button
          class="quote"
          type="button"
          aria-label={`预览引用：${name(reference)}`}
          title={reference.source?.path ?? "预览引用"}
          onclick={() => void show(reference)}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true"
            ><path d="M8 5H4v6h4V5Zm8 0h-4v6h4V5ZM8 11c0 3-2 4-4 4m12-4c0 3-2 4-4 4" /></svg
          >
          <span
            ><strong>{name(reference)}</strong><span class="excerpt">{reference.text}</span></span
          >
        </button>
        {#if onRemove}<button
            class="remove"
            type="button"
            aria-label={`移除引用：${name(reference)}`}
            title="移除引用"
            {disabled}
            onclick={() => onRemove?.(reference.id)}
            ><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 6 8 8M14 6l-8 8" /></svg
            ></button
          >{/if}
      </li>{/each}
  </ul>{/if}
<dialog
  bind:this={dialog}
  aria-label="引用预览"
  onclose={() => {
    preview = null;
    error = "";
  }}
>
  {#if preview}<header>
      <div>
        <h2 title={name(preview)}>{name(preview)}</h2>
        <p title={preview.source?.path}>
          {preview.source
            ? preview.source.path.includes("/")
              ? preview.source.path.slice(0, preview.source.path.lastIndexOf("/"))
              : "当前笔记库"
            : "没有文件来源的选中文字"}
        </p>
      </div>
      <button type="button" aria-label="关闭引用预览" onclick={() => dialog.close()}>×</button>
    </header>
    <!-- svelte-ignore a11y_no_noninteractive_tabindex (长引用具有独立滚动区，键盘用户需要聚焦后滚动与复制原文。) -->
    <blockquote tabindex="0" role="document" aria-label="引用原文">{preview.text}</blockquote>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <footer>
      {#if preview.source && onOpen}<button
          class="source"
          type="button"
          disabled={opening}
          onclick={() => void openSource()}
          >{opening ? "正在定位…" : "跳回原文"}<span aria-hidden="true">↗</span></button
        >{/if}<button type="button" onclick={() => dialog.close()}>关闭</button>
    </footer>
  {/if}
</dialog>

<style>
  .references {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 0;
    margin: 0 0 10px;
    list-style: none;
    max-height: 126px;
    overflow-y: auto;
  }
  li {
    display: flex;
    align-items: stretch;
    min-width: 0;
    max-width: 100%;
    width: auto;
    flex: 1 1 140px;
    border: 1px solid var(--border);
    border-radius: var(--radius-control, 9px);
    background: var(--bg);
  }
  button {
    font: inherit;
    cursor: pointer;
    color: inherit;
    border: 0;
    background: transparent;
    border-radius: 7px;
    transition:
      background 120ms ease,
      color 120ms ease;
  }
  button:disabled {
    cursor: default;
    opacity: 0.45;
  }
  button:hover:not(:disabled) {
    background: var(--control-hover, var(--selected));
  }
  button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .quote {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 7px 8px;
    flex: 1;
    min-width: 0;
    text-align: left;
  }
  .quote > span {
    min-width: 0;
    flex: 1;
  }
  strong,
  .excerpt {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  strong {
    font-size: 11px;
    font-weight: 550;
  }
  .excerpt {
    font-size: 10px;
    color: var(--muted);
    margin-top: 3px;
  }
  svg {
    width: 15px;
    height: 15px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
    stroke-linecap: round;
    flex-shrink: 0;
    color: var(--muted);
  }
  .remove {
    padding: 4px;
    align-self: center;
    margin-right: 3px;
    width: 24px;
    height: 26px;
  }
  dialog {
    width: min(460px, calc(100vw - 32px));
    max-height: min(560px, calc(100dvh - 32px));
    box-sizing: border-box;
    padding: 18px;
    border: 1px solid var(--border);
    border-radius: var(--radius-panel, 14px);
    color: var(--fg);
    background: var(--surface, var(--bg));
    box-shadow: var(--shadow-popover);
  }
  dialog::backdrop {
    background: var(--scrim, #0005);
  }
  header {
    display: flex;
    align-items: start;
    gap: 12px;
  }
  header div {
    flex: 1;
    min-width: 0;
  }
  header button {
    font-size: 22px;
    width: 28px;
    height: 28px;
  }
  h2 {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 14px;
    margin: 0;
    font-weight: 550;
  }
  p {
    margin: 6px 0 0;
    color: var(--muted);
    font-size: 11px;
    overflow-wrap: anywhere;
  }
  blockquote {
    border-left: 2px solid var(--border);
    padding: 0 0 0 14px;
    margin: 18px 0;
    max-height: min(340px, 50dvh);
    overflow: auto;
    line-height: 1.8;
    font-size: 13px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;
  }
  footer {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }
  footer button {
    padding: 7px 10px;
    font-size: 12px;
  }
  .source {
    margin-right: auto;
    color: var(--accent);
  }
  .source span {
    margin-left: 6px;
  }
  .error {
    color: var(--danger);
    margin-bottom: 10px;
  }
  @media (prefers-reduced-motion: reduce) {
    button {
      transition: none;
    }
  }
</style>
