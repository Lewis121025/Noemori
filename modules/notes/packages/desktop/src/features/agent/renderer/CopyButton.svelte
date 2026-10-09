<script lang="ts">
  import { onDestroy } from "svelte";
  let {
    text,
    label = "复制",
    iconOnly = false,
  }: { text: string; label?: string; iconOnly?: boolean } = $props();
  let copied = $state(false);
  let copying = $state(false);
  let issue = $state("");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let live = true;

  $effect(() => {
    void text;
    copied = false;
    issue = "";
    if (timer !== undefined) clearTimeout(timer);
  });
  onDestroy(() => {
    live = false;
    if (timer !== undefined) clearTimeout(timer);
  });
  async function copy(): Promise<void> {
    if (copying) return;
    const value = text;
    copying = true;
    issue = "";
    try {
      await navigator.clipboard.writeText(value);
      if (!live || text !== value) return;
      copied = true;
      timer = setTimeout(() => (copied = false), 2000);
    } catch {
      if (live && text === value) issue = "复制失败，请重试。";
    } finally {
      if (live) copying = false;
    }
  }
</script>

<span class="copy-control">
  <button
    type="button"
    class:copied
    aria-label={copied ? "已复制" : label}
    title={copied ? "已复制" : label}
    disabled={copying}
    onclick={() => void copy()}
  >
    <svg viewBox="0 0 20 20" aria-hidden="true">
      {#if copied}<path d="m4 10 4 4 8-8" />
      {:else}<rect x="7" y="7" width="9" height="10" rx="2" /><path
          d="M12 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"
        />{/if}
    </svg>
    {#if !iconOnly}<span>{copied ? "已复制" : label}</span>{/if}
  </button>
  <span class="copy-status" role="status">{copied ? "已复制" : ""}</span>
  {#if issue}<span class="copy-issue" role="alert">{issue}</span>{/if}
</span>

<style>
  .copy-control {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    min-width: 28px;
    min-height: 28px;
    padding: 4px 6px;
    border: 0;
    border-radius: var(--radius-control);
    background: transparent;
    color: var(--muted);
    font: inherit;
    font-size: 11px;
    cursor: pointer;
    transition:
      background var(--motion-fast) var(--motion-ease),
      color var(--motion-fast) var(--motion-ease);
  }
  button:hover:not(:disabled) {
    background: var(--control-hover, var(--selected));
    color: var(--fg);
  }
  button.copied {
    background: var(--selected);
    color: var(--accent);
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .copy-status {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
  .copy-issue {
    font-size: 11px;
    color: var(--danger);
  }
  @media (prefers-reduced-motion: reduce) {
    button {
      transition: none;
    }
  }
</style>
