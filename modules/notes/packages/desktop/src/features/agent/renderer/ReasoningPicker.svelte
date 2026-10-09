<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import type { ReasoningEffort } from "../shared/reasoning";

  let {
    efforts,
    value,
    saving,
    running,
    error,
    opened = $bindable(false),
    onopen,
    onselect,
  }: {
    efforts: readonly ReasoningEffort[];
    value: ReasoningEffort | undefined;
    saving: boolean;
    running: boolean;
    error: string;
    opened?: boolean;
    onopen: () => void;
    onselect: (effort: ReasoningEffort) => Promise<boolean>;
  } = $props();
  let element: HTMLDivElement;
  let trigger: HTMLButtonElement;
  let menu: HTMLDivElement | undefined = $state();
  const instanceId = $props.id();
  const anchorName = `--reasoning-${instanceId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  let live = true;
  onDestroy(() => {
    live = false;
  });

  function close(focus = false): void {
    opened = false;
    if (focus) trigger.focus();
  }
  function toggle(): void {
    if (opened) {
      close();
      return;
    }
    onopen();
    opened = true;
    void tick().then(() => {
      if (live && opened) {
        const selected = menu?.querySelector<HTMLButtonElement>('[aria-checked="true"]');
        (selected ?? menu?.querySelector<HTMLButtonElement>('[role="menuitemradio"]'))?.focus();
      }
    });
  }
  /** 顶层浮层跟随自己的入口，不占用模型列表高度或被输入区裁剪。 */
  function showMenu(node: HTMLDivElement): void {
    node.showPopover();
  }
  async function select(effort: ReasoningEffort): Promise<void> {
    if (saving) return;
    if (effort === value) {
      close(true);
      return;
    }
    const source = menu;
    const saved = await onselect(effort);
    // 失败保留菜单和错误；迟到成功不抢回用户已转移的焦点。
    if (saved && live && opened && menu === source) close(true);
  }
  function navigate(event: KeyboardEvent): void {
    if (!menu || event.isComposing || saving) return;
    const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
    if (!keys.includes(event.key)) return;
    const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));
    event.preventDefault();
    const index = items.findIndex((item) => item === document.activeElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  }
</script>

<svelte:window
  onpointerdown={(event) => {
    if (opened && event.target instanceof Node && !element.contains(event.target)) close();
  }}
  onkeydown={(event) => {
    if (opened && event.key === "Escape" && !event.isComposing) close(true);
  }}
/>
<div
  class="reasoning-picker"
  bind:this={element}
  onfocusout={(event) => {
    if (opened && event.relatedTarget instanceof Node && !element.contains(event.relatedTarget))
      close();
  }}
>
  <button
    class="reasoning-trigger"
    type="button"
    aria-label="选择推理强度"
    aria-haspopup="menu"
    aria-expanded={opened}
    aria-controls={`${instanceId}-efforts`}
    title={value === undefined ? "选择推理强度" : `推理强度：${value}`}
    style:anchor-name={anchorName}
    bind:this={trigger}
    disabled={saving}
    onclick={toggle}
  >
    <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 6h12M4 14h12M7 3v6M13 11v6" /></svg>
    <span>{value ?? "推理强度"}</span>
    <svg class="chevron" viewBox="0 0 20 20" aria-hidden="true"><path d="m6 8 4 4 4-4" /></svg>
  </button>
  {#if opened}<div
      class="reasoning-menu"
      id={`${instanceId}-efforts`}
      role="menu"
      aria-label="对话推理强度"
      popover="manual"
      style:position-anchor={anchorName}
      bind:this={menu}
      use:showMenu
    >
      <p class="menu-title">推理强度</p>
      {#each efforts as effort (effort)}
        <button
          class="effort-option"
          type="button"
          role="menuitemradio"
          aria-checked={value === effort}
          disabled={saving}
          onkeydown={navigate}
          onclick={() => void select(effort)}
        >
          <span>{effort}</span>
          <svg class:chosen={value === effort} viewBox="0 0 20 20" aria-hidden="true"
            ><path d="m4 10 4 4 8-8" /></svg
          >
        </button>
      {/each}
      {#if running}<p class="next-turn">切换从下一轮生效</p>{/if}
      {#if error}<p class="error" role="alert">{error}</p>{/if}
    </div>{/if}
</div>

<style>
  .reasoning-picker {
    flex-shrink: 0;
  }
  button {
    font: inherit;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
    flex-shrink: 0;
  }
  .reasoning-trigger {
    display: flex;
    align-items: center;
    gap: 5px;
    min-height: 28px;
    padding: 4px 6px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--muted);
    font-size: 11px;
    white-space: nowrap;
  }
  .reasoning-trigger:hover,
  .reasoning-trigger[aria-expanded="true"] {
    background: var(--selected);
    color: var(--fg);
  }
  .reasoning-trigger:focus-visible {
    outline-offset: -1px;
  }
  .chevron {
    width: 12px;
    height: 12px;
  }
  .reasoning-picker .reasoning-menu {
    --menu-width: min(208px, calc(100vw - 24px));
    position: fixed;
    inset: auto;
    position-area: top span-all;
    position-try-fallbacks: flip-block;
    left: clamp(12px, anchor(left), calc(100vw - var(--menu-width) - 12px));
    justify-self: start;
    margin: 0 0 8px;
    width: var(--menu-width);
    max-height: min(360px, calc(100dvh - 24px));
    overflow: auto;
    box-sizing: border-box;
    padding: 6px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--surface);
    color: var(--fg);
    box-shadow: var(--shadow-popover);
  }
  .menu-title {
    margin: 2px 8px 6px;
    font-size: 11px;
    color: var(--muted);
  }
  .effort-option {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    min-height: 30px;
    padding: 5px 8px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--fg);
    text-align: left;
    font-size: 12px;
  }
  .effort-option:hover,
  .effort-option[aria-checked="true"] {
    background: var(--selected);
  }
  .effort-option:focus-visible {
    outline-offset: -2px;
  }
  .effort-option svg {
    visibility: hidden;
    color: var(--accent);
  }
  .effort-option svg.chosen {
    visibility: visible;
  }
  .next-turn,
  .error {
    margin: 6px 8px 2px;
    font-size: 11px;
    color: var(--muted);
    overflow-wrap: anywhere;
  }
  .error {
    color: var(--danger);
  }
</style>
