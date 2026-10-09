<script module lang="ts">
  import type { Command } from "prosemirror-state";

  /** 编辑菜单区分文档命令、对话框入口和子分类；可用性与选中态由所属编辑器提供。 */
  export type FormattingMenuItem = {
    id: string;
    label: string;
    disabled?: boolean;
    /** 调色板色样同时适配明暗主题，不依赖颜色名称辨识。 */
    swatch?: { light: string; dark: string };
  } & (
    | { kind: "command"; command: Command; checked?: boolean }
    | { kind: "action"; action: () => void }
    | { kind: "submenu"; items: readonly FormattingMenuItem[] }
  );
</script>

<script lang="ts">
  import { tick } from "svelte";
  let {
    id,
    label,
    text,
    icon,
    indicator,
    pressed,
    items,
    onCommand,
  }: {
    id: string;
    label: string;
    text?: string;
    icon?: string;
    /** 当前配色显示在入口下方，切换选区后仍能辨识正在使用的颜色。 */
    indicator?: { light: string; dark: string } | null;
    /** 格式菜单的完整选区状态；与菜单展开状态分开表达，mixed 提示部分应用。 */
    pressed?: boolean | "mixed";
    items: readonly FormattingMenuItem[];
    onCommand: (command: Command) => void;
  } = $props();
  let trigger: HTMLButtonElement;
  let root: HTMLDivElement;
  let opened = $state<string[]>([]);

  function track(menuId: string, event: ToggleEvent): void {
    opened =
      event.newState === "open"
        ? [...opened.filter((value) => value !== menuId), menuId]
        : opened.filter((value) => value !== menuId);
  }
  function children(menu: HTMLElement): HTMLButtonElement[] {
    return Array.from(menu.children).filter(
      (child): child is HTMLButtonElement => child instanceof HTMLButtonElement && !child.disabled,
    );
  }
  function target(button: HTMLButtonElement): HTMLElement | null {
    return button.popoverTargetElement instanceof HTMLElement ? button.popoverTargetElement : null;
  }
  async function enter(button: HTMLButtonElement, last = false): Promise<void> {
    const menu = target(button);
    if (!menu || button.disabled) return;
    if (!menu.matches(":popover-open")) button.click();
    await tick();
    const options = children(menu);
    (last ? options.at(-1) : options[0])?.focus();
  }
  function hover(event: PointerEvent): void {
    if (event.pointerType !== "mouse" || !(event.currentTarget instanceof HTMLButtonElement))
      return;
    const button = event.currentTarget;
    const menu = button.parentElement;
    if (!menu) return;
    const next = button.disabled ? null : target(button);
    // 不在移出按钮时关闭子菜单，鼠标可以沿对角线穿过父子菜单之间的间隙。
    for (const child of Array.from(menu.children)) {
      if (child instanceof HTMLElement && child !== next && child.matches("[popover]:popover-open"))
        child.hidePopover();
    }
    if (next && !next.matches(":popover-open")) button.click();
  }
  function keydown(event: KeyboardEvent): void {
    if (event.isComposing || !(event.currentTarget instanceof HTMLElement)) return;
    const menu = event.currentTarget;
    const options = children(menu);
    const focused = document.activeElement;
    const index = options.findIndex((button) => button === focused);
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? options.length - 1
            : (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
      options[next]?.focus();
    } else if (
      event.key === "ArrowRight" &&
      focused instanceof HTMLButtonElement &&
      target(focused)
    ) {
      event.preventDefault();
      event.stopPropagation();
      void enter(focused);
    } else if (event.key === "Escape" || event.key === "ArrowLeft") {
      event.preventDefault();
      event.stopPropagation();
      menu.hidePopover();
      const parent = menu === root ? trigger : menu.previousElementSibling;
      if (parent instanceof HTMLButtonElement) parent.focus();
    } else if (event.key === "Tab") {
      root.hidePopover();
      trigger.focus();
    }
  }
  function choose(item: Exclude<FormattingMenuItem, { kind: "submenu" }>): void {
    root.hidePopover();
    if (item.kind === "command") onCommand(item.command);
    else item.action();
  }
</script>

<button
  bind:this={trigger}
  class="reader-button menu-trigger"
  class:with-text={text !== undefined}
  type="button"
  aria-label={label}
  title={label}
  aria-haspopup="menu"
  aria-expanded={opened.includes(id)}
  aria-pressed={pressed}
  popovertarget={id}
  onkeydown={(event) => {
    if (event.isComposing || !["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) return;
    event.preventDefault();
    void enter(trigger, event.key === "ArrowUp");
  }}
>
  {#if text !== undefined}<span>{text}</span>
  {:else if icon}<svg class="reader-icon" viewBox="0 0 24 24" aria-hidden="true"
      ><path d={icon} /></svg
    >{/if}
  <svg class="chevron" viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3" /></svg>
  {#if indicator}<span
      class="color-indicator"
      style:background="light-dark({indicator.light}, {indicator.dark})"
      aria-hidden="true"
    ></span>{/if}
</button>
<div
  {id}
  bind:this={root}
  class="reader-popover formatting-menu"
  popover="auto"
  role="menu"
  aria-label={label}
  tabindex="-1"
  onbeforetoggle={(event) => track(id, event)}
  onkeydown={keydown}
>
  {@render entries(items, id)}
</div>

{#snippet entries(options: readonly FormattingMenuItem[], parentId: string)}
  {#each options as item (item.id)}
    {@const itemId = `${parentId}-${item.id}`}
    {#if item.kind === "submenu"}
      <button
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={opened.includes(itemId)}
        popovertarget={itemId}
        popovertargetaction="show"
        disabled={item.disabled}
        onpointerenter={hover}
        onkeydown={(event) => {
          if (!event.isComposing && (event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            void enter(event.currentTarget);
          }
        }}
        >{item.label}<svg class="submenu-arrow" viewBox="0 0 12 12" aria-hidden="true"
          ><path d="m4.5 3 3 3-3 3" /></svg
        ></button
      >
      <div
        id={itemId}
        class="reader-popover formatting-menu submenu"
        popover="auto"
        role="menu"
        aria-label={item.label}
        tabindex="-1"
        onbeforetoggle={(event) => track(itemId, event)}
        onkeydown={keydown}
      >
        {@render entries(item.items, itemId)}
      </div>
    {:else}
      {@const checked = item.kind === "command" ? item.checked : undefined}
      <button
        type="button"
        role={checked === undefined ? "menuitem" : "menuitemradio"}
        aria-checked={checked}
        aria-label={item.label}
        disabled={item.disabled}
        onpointerenter={hover}
        onclick={() => choose(item)}
        ><span class="option-label"
          >{#if item.swatch}<span
              class="swatch"
              style:background="light-dark({item.swatch.light}, {item.swatch.dark})"
              aria-hidden="true"
            ></span>{/if}{item.label}</span
        ><span class="check" aria-hidden="true">{checked ? "✓" : ""}</span></button
      >
    {/if}
  {/each}
{/snippet}

<style>
  .menu-trigger {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    gap: 2px;
    height: 30px;
    min-height: 30px;
    padding: 0 4px;
  }
  .menu-trigger .reader-icon {
    width: 17px;
    height: 17px;
  }
  .menu-trigger[aria-expanded="true"] {
    color: var(--fg);
    background: var(--selected);
  }
  .menu-trigger[aria-pressed="mixed"]::after {
    content: "";
    position: absolute;
    bottom: 2px;
    left: 9px;
    width: 6px;
    height: 2px;
    border-radius: 1px;
    background: var(--accent);
  }
  .with-text {
    min-width: 68px;
    justify-content: space-between;
    padding-inline: 7px;
    font-size: 12px;
  }
  .chevron,
  .submenu-arrow {
    width: 10px;
    height: 10px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .formatting-menu {
    min-width: 154px;
    padding: 5px;
  }
  .submenu {
    position-area: right span-bottom;
    margin: 0 4px;
  }
  .formatting-menu > button {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 20px;
    width: 100%;
    min-height: 30px;
    padding: 6px 10px;
    border: 0;
    border-radius: 6px;
    font: inherit;
    font-size: 12px;
    text-align: left;
    white-space: nowrap;
    color: var(--fg);
    background: transparent;
    cursor: pointer;
  }
  .formatting-menu > button:hover:not(:disabled),
  .formatting-menu > button:focus-visible,
  .formatting-menu > button[aria-expanded="true"] {
    background: var(--selected);
  }
  .formatting-menu > button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .check {
    width: 10px;
    color: var(--accent);
  }
  .option-label {
    display: inline-flex;
    align-items: center;
    gap: 9px;
  }
  .swatch {
    width: 12px;
    height: 12px;
    border-radius: 3px;
    box-shadow: inset 0 0 0 1px light-dark(#00000012, #ffffff16);
  }
  .color-indicator {
    position: absolute;
    bottom: 2px;
    left: 6px;
    width: 14px;
    height: 3px;
    border-radius: 2px;
  }
</style>
