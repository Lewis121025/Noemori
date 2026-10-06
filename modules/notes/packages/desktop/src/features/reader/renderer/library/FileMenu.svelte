<script module lang="ts">
  /** 文件菜单可以发出的动作；`bookmark` 切换条目的收藏状态。 */
  export type FileMenuAction =
    | "file"
    | "directory"
    | "rename"
    | "move"
    | "trash"
    | "reveal"
    | "export"
    | "locate"
    | "bookmark";
</script>

<script lang="ts">
  import { tick } from "svelte";
  import type { VaultEntry } from "../../shared/api";
  let {
    onAction,
    bookmarked,
    selectionCount = 0,
  }: {
    onAction: (action: FileMenuAction, entry: VaultEntry | null) => void;
    /** 条目是否已收藏；决定菜单显示「加入」还是「移出」书签。 */
    bookmarked: (entry: VaultEntry) => boolean;
    selectionCount?: number;
  } = $props();
  let element: HTMLDivElement;
  let target = $state<VaultEntry | null>(null);
  let left = $state(0);
  let top = $state(0);
  let opened = false;
  let returnFocus: HTMLElement | null = null;
  const multiple = $derived(target !== null && selectionCount > 1);
  /** 打开当前条目的菜单；位置限制在窗口内，键盘焦点进入第一项。 */
  export async function open(entry: VaultEntry | null, x: number, y: number): Promise<void> {
    target = entry;
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
  function choose(action: FileMenuAction): void {
    close(true);
    onAction(action, target);
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

<!-- macOS 在按下右键时触发 contextmenu；auto 会被紧接着的松开事件误关。 -->
<svelte:window
  onpointerdown={dismissOutside}
  onblur={() => close(false)}
  onresize={() => close(false)}
/>
<div
  class="file-menu"
  popover="manual"
  role="menu"
  aria-label="文件操作"
  bind:this={element}
  style:left="{left}px"
  style:top="{top}px"
  onkeydown={keydown}
  tabindex="-1"
>
  {#if target !== null && !multiple}
    <button role="menuitem" onclick={() => choose("file")}>新建笔记</button>
    <button role="menuitem" onclick={() => choose("directory")}>新建文件夹</button>
  {/if}
  {#if target !== null}
    <div class="separator" role="separator"></div>
    {#if !multiple}<button role="menuitem" onclick={() => choose("rename")}>重命名…</button>{/if}
    <button role="menuitem" onclick={() => choose("move")}>移动到…</button>
    <button role="menuitem" onclick={() => choose("export")}>导出…</button>
    {#if !multiple}<button role="menuitem" onclick={() => choose("bookmark")}
        >{bookmarked(target) ? "移出书签" : "加入书签"}</button
      >
      <button role="menuitem" onclick={() => choose("reveal")}>在系统文件夹中显示</button>{/if}
    <div class="separator" role="separator"></div>
    <button role="menuitem" class="danger" onclick={() => choose("trash")}>移到废纸篓…</button>
  {:else}
    <button role="menuitem" onclick={() => choose("locate")}>定位当前文件</button>
  {/if}
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
