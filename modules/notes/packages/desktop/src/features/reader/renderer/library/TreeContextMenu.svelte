<script lang="ts">
  import { tick } from "svelte";
  let {
    items,
    label,
    onAction,
  }: {
    items: { id: string; label: string; danger?: boolean; separator?: boolean }[];
    label: string;
    onAction: (id: string) => void;
  } = $props();
  let element: HTMLDivElement;
  let left = $state(0);
  let top = $state(0);
  let opened = false;
  let returnFocus: HTMLElement | null = null;
  /**
   * 打开条目菜单并把键盘焦点交给第一项；新建与文件定位由固定入口负责。
   * @param x 菜单期望的横坐标，超出窗口时收回可见范围。
   * @param y 菜单期望的纵坐标，超出窗口时收回可见范围。
   * @returns 菜单布局与焦点交接完成后兑现。
   * @throws 原生浮层不可用时保留浏览器异常。
   */
  export async function open(x: number, y: number): Promise<void> {
    left = x;
    top = y;
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element.showPopover();
    opened = true;
    await tick();
    if (!opened) return;
    const bounds = element.getBoundingClientRect();
    left = Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8));
    top = Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8));
    await tick();
    if (opened) element.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
  }
  function close(restoreFocus: boolean): void {
    if (!opened) return;
    element.hidePopover();
    opened = false;
    if (restoreFocus && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  }
  function dismissOutside(event: PointerEvent): void {
    if (event.target instanceof Node && !element.contains(event.target)) close(false);
  }
  function choose(action: string): void {
    close(true);
    onAction(action);
  }
  function keydown(event: KeyboardEvent): void {
    if (event.key === "Escape" || event.key === "Tab") {
      close(true);
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const buttons = Array.from(element.querySelectorAll<HTMLButtonElement>("button"));
    const index = buttons.findIndex((button) => button === document.activeElement);
    buttons[
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length
    ]?.focus();
  }
</script>

<svelte:window
  onpointerdown={dismissOutside}
  onblur={() => close(false)}
  onresize={() => close(false)}
/>
<div
  class="file-menu"
  popover="manual"
  role="menu"
  aria-label={label}
  bind:this={element}
  style:left="{left}px"
  style:top="{top}px"
  onkeydown={keydown}
  tabindex="-1"
>
  {#each items as item (item.id)}
    {#if item.separator}<div class="separator" role="separator"></div>{/if}
    <button type="button" role="menuitem" class:danger={item.danger} onclick={() => choose(item.id)}
      >{item.label}</button
    >
  {/each}
</div>

<style>
  .file-menu {
    position: fixed;
    inset: auto;
    margin: 0;
    width: 13rem;
    max-width: calc(100vw - 1rem);
    max-height: calc(100dvh - 1rem);
    overflow-y: auto;
    padding: 0.35rem;
    background: color-mix(in srgb, var(--bg) 94%, transparent);
    backdrop-filter: blur(20px);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 0.7rem;
    box-shadow:
      0 4px 10px var(--shadow),
      0 16px 40px var(--shadow);
    font-size: 0.85rem;
  }
  button {
    display: block;
    width: 100%;
    border: 0;
    border-radius: 0.3rem;
    background: transparent;
    font: inherit;
    color: inherit;
    text-align: left;
    padding: 0.4rem 0.65rem;
    cursor: pointer;
  }
  button:hover,
  button:focus-visible {
    background: var(--selected);
    outline: none;
  }
  .separator {
    border-top: 1px solid var(--border);
    margin: 0.3rem;
  }
  .danger {
    color: var(--danger);
  }
</style>
