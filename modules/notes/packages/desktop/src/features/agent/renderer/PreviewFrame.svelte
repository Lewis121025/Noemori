<script lang="ts">
  import { tick, type Snippet } from "svelte";
  import CodeBlock from "./CodeBlock.svelte";
  import CopyButton from "./CopyButton.svelte";
  import { previewPortal } from "./preview-portal";

  let {
    text,
    language,
    label,
    source = $bindable(false),
    busy = false,
    onInspect,
    actions,
    feedback,
    children,
  }: {
    text: string;
    language: string;
    label: string;
    source?: boolean;
    busy?: boolean;
    onInspect?: (() => void) | undefined;
    actions?: Snippet;
    feedback?: Snippet;
    children: Snippet;
  } = $props();
  let host: HTMLDivElement | undefined;
  let dialog = $state<HTMLDialogElement | null>(null);
  let enlarged = $state(false);

  async function close(): Promise<void> {
    dialog?.close();
    enlarged = false;
    host?.style.removeProperty("height");
    await tick();
    if (host?.isConnected) host.querySelector<HTMLButtonElement>("[data-expand-preview]")?.focus();
  }
  async function toggleSize(): Promise<void> {
    onInspect?.();
    if (enlarged) {
      await close();
      return;
    }
    if (!dialog || !host) return;
    dialog.showModal();
    host.style.height = `${host.getBoundingClientRect().height}px`;
    enlarged = true;
    await tick();
    if (dialog?.open) dialog.querySelector<HTMLButtonElement>("[data-expand-preview]")?.focus();
  }
</script>

<div class="preview-host" bind:this={host}>
  <div
    class="preview-frame"
    data-language={language}
    use:previewPortal={enlarged ? dialog : null}
    aria-busy={busy && !source}
  >
    <div class="preview-tools" role="group" aria-label={`${label}操作`}>
      <CopyButton {text} label="复制代码" iconOnly />
      {@render actions?.()}
      <button
        class="preview-action"
        type="button"
        data-expand-preview
        aria-label={enlarged ? "关闭放大预览" : "放大预览"}
        title={enlarged ? "关闭" : "放大预览"}
        onclick={() => void toggleSize()}
        ><svg viewBox="0 0 20 20" aria-hidden="true">
          {#if enlarged}<path d="m5 5 10 10M15 5 5 15" />{:else}<path
              d="M3 7V3h4m6 0h4v4m0 6v4h-4m-6 0H3v-4"
            />{/if}
        </svg></button
      >
      <button
        class="preview-action"
        type="button"
        aria-label={source ? "预览" : "源码"}
        title={source ? "返回预览" : "查看源码"}
        aria-pressed={source}
        onclick={() => {
          onInspect?.();
          source = !source;
        }}
        ><svg viewBox="0 0 20 20" aria-hidden="true">
          {#if source}<path d="M2 10s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5Z" /><circle
              cx="10"
              cy="10"
              r="2"
            />
          {:else}<path d="m6 6-4 4 4 4m8-8 4 4-4 4m-3-10-2 12" />{/if}
        </svg></button
      >
    </div>
    <div class="preview-body">
      {#if source}<CodeBlock {text} {language} showHeader={false} />
      {:else}{@render children()}{/if}
    </div>
    {@render feedback?.()}
  </div>
</div>
<dialog
  class="preview-dialog"
  aria-label={`${label}放大预览`}
  bind:this={dialog}
  oncancel={(event) => {
    event.preventDefault();
    void close();
  }}
></dialog>

<style>
  .preview-frame {
    position: relative;
    min-width: 0;
    border-radius: 10px;
    background: color-mix(in srgb, var(--fg) 2.5%, var(--bg));
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--fg) 5%, transparent);
  }
  .preview-host {
    min-width: 0;
  }
  .preview-tools {
    position: absolute;
    z-index: 1;
    top: 7px;
    right: 7px;
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 2px;
    border-radius: 8px;
    background: transparent;
    opacity: 0.4;
    transition: opacity var(--motion-fast) var(--motion-ease);
  }
  .preview-frame:hover .preview-tools,
  .preview-frame:focus-within .preview-tools {
    opacity: 1;
    background: var(--surface);
    box-shadow: 0 1px 6px var(--shadow);
  }
  .preview-tools :global(.preview-action) {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    padding: 0;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
  }
  .preview-tools :global(.preview-action:hover:not(:disabled)) {
    background: var(--control-hover, var(--selected));
    color: var(--fg);
  }
  .preview-tools :global(.preview-action:focus-visible) {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .preview-tools :global(.preview-action:disabled) {
    opacity: 0.5;
    cursor: default;
  }
  .preview-tools :global(svg) {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .preview-body {
    min-width: 0;
    overflow: hidden;
    border-radius: inherit;
  }
  .preview-body :global(.code-block) {
    margin: 0;
    border-radius: 0;
    background: transparent;
  }
  .preview-body :global(iframe) {
    display: block;
    width: 100%;
    border: 0;
  }
  .preview-dialog {
    width: min(1000px, calc(100vw - 48px));
    max-width: none;
    max-height: calc(100dvh - 48px);
    padding: 0;
    border: 0;
    border-radius: 14px;
    background: var(--bg);
    color: var(--fg);
    box-shadow: var(--shadow-popover);
  }
  .preview-dialog::backdrop {
    background: var(--scrim, #0005);
  }
  .preview-dialog :global(.preview-tools) {
    opacity: 1;
  }
  .preview-dialog :global(iframe) {
    max-height: calc(100dvh - 80px);
  }
  .preview-dialog :global(.preview-frame[data-language="html"] iframe) {
    height: calc(80dvh - 48px);
  }
  @media (hover: none) {
    .preview-tools {
      opacity: 1;
      pointer-events: auto;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .preview-tools {
      transition: none;
    }
  }
</style>
