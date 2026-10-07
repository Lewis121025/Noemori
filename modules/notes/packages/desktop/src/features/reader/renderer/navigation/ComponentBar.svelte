<script lang="ts">
  import { tick } from "svelte";
  import { selectionIndicator } from "../selection-indicator";
  import { SIDEBAR_COMPONENTS, type SidebarEntry } from "./sidebar-components";

  let {
    active,
    compact = false,
    disabled,
    canRun,
    onSelect,
  }: {
    active: SidebarEntry["id"];
    compact?: boolean;
    disabled: boolean;
    canRun: (entry: SidebarEntry) => boolean;
    onSelect: (entry: SidebarEntry) => void;
  } = $props();
  let scroller: HTMLDivElement;
  let focused = $state<string | null>(null);

  $effect(() => {
    const selected = active;
    focused = selected;
    void tick().then(() => {
      if (scroller?.isConnected)
        scroller
          .querySelector<HTMLElement>(`[data-component="${selected}"]`)
          ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  });

  function navigate(event: KeyboardEvent): void {
    const previousKey = compact ? "ArrowUp" : "ArrowLeft",
      nextKey = compact ? "ArrowDown" : "ArrowRight";
    if (![previousKey, nextKey, "Home", "End"].includes(event.key)) return;
    const buttons = Array.from(
      scroller.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
    );
    if (buttons.length === 0) return;
    event.preventDefault();
    const index = buttons.findIndex((button) => button === document.activeElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : (index + (event.key === nextKey ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  }

  function scroll(event: WheelEvent): void {
    if (event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
    const distance =
      event.deltaY *
      (event.deltaMode === 1 ? 32 : event.deltaMode === 2 ? scroller.clientWidth : 1);
    const next = Math.max(
      0,
      Math.min(scroller.scrollWidth - scroller.clientWidth, scroller.scrollLeft + distance),
    );
    if (next === scroller.scrollLeft) return;
    event.preventDefault();
    scroller.scrollLeft = next;
  }
</script>

<div class="component-bar" class:compact>
  <div
    class="component-scroll"
    use:selectionIndicator={active}
    role="toolbar"
    aria-label="组件栏"
    aria-orientation={compact ? "vertical" : "horizontal"}
    tabindex="-1"
    bind:this={scroller}
    onkeydown={navigate}
    onwheel={scroll}
  >
    {#each SIDEBAR_COMPONENTS as entry (entry.id)}
      <button
        class="component-button"
        type="button"
        data-component={entry.id}
        aria-label={entry.label}
        title={entry.label}
        aria-pressed={active === entry.id}
        disabled={disabled || !canRun(entry)}
        tabindex={(focused ?? active) === entry.id ? 0 : -1}
        onfocus={() => (focused = entry.id)}
        onclick={() => onSelect(entry)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d={entry.icon} /></svg>
        <span class="component-name">{entry.label}</span>
      </button>
    {/each}
  </div>
</div>

<style>
  .component-bar {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    min-width: 0;
    gap: 0.25rem;
    padding: 0.45rem 0.5rem;
    border-bottom: 1px solid var(--border);
    background: var(--sidebar);
  }
  .component-scroll {
    display: flex;
    flex: 1;
    min-width: 0;
    gap: 0.3rem;
    overflow-x: auto;
    overscroll-behavior-x: contain;
    scrollbar-width: none;
  }
  .compact {
    padding: 7px 5px;
    border-bottom: 0;
  }
  .compact .component-scroll {
    flex-direction: column;
    overflow-x: hidden;
    overflow-y: auto;
  }
  .compact .component-button {
    flex: 0 0 40px;
    min-height: 40px;
    padding: 7px;
  }
  .compact .component-name {
    display: none;
  }
  .compact svg {
    width: 18px;
    height: 18px;
  }
  .component-scroll::-webkit-scrollbar {
    display: none;
  }
  .component-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 1 0 54px;
    flex-direction: column;
    gap: 4px;
    min-height: 52px;
    padding: 7px 4px;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
  }
  .component-button:hover:not(:disabled),
  .component-button[aria-pressed="true"] {
    color: var(--fg);
    background: var(--selected);
  }
  .component-button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .component-button:focus-visible {
    outline-offset: -2px;
  }
  svg {
    width: 22px;
    height: 22px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .component-name {
    font: inherit;
    font-size: 0.68rem;
    white-space: nowrap;
  }
</style>
