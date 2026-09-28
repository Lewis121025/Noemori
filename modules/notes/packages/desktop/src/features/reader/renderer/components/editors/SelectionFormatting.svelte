<script lang="ts">
  /** 选中文字后提供就地格式操作；工具条不持有另一份选区，也不在出现时请求焦点。 */
  import { TextSelection, type Command, type EditorState, type Selection } from "prosemirror-state";
  import type { EditorView } from "prosemirror-view";
  import InlineFormatting from "./InlineFormatting.svelte";
  import { writingCommands } from "../../engine/editing/writing";
  import { placeSelectionToolbar } from "../../engine/editing/selection-toolbar";
  import { isCompositionKey } from "../../engine/editing/composition";

  let {
    view,
    state,
    blocked,
    onLink,
  }: {
    view: EditorView;
    state: EditorState;
    blocked: boolean;
    onLink: () => void;
  } = $props();
  let panel: HTMLDivElement;
  let frame = 0;
  let dragging = false;
  let dismissed: Selection | null = null;
  const applicable = $derived(
    state.selection instanceof TextSelection &&
      !state.selection.empty &&
      writingCommands.bold(state),
  );

  function enabledButtons(): HTMLButtonElement[] {
    return Array.from(panel.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
  }

  function updatePosition(): void {
    frame = 0;
    const current = view.state;
    const selection = current.selection;
    if (dismissed && !dismissed.eq(selection)) dismissed = null;
    if (
      blocked ||
      dragging ||
      view.isDestroyed ||
      view.composing ||
      dismissed !== null ||
      !(selection instanceof TextSelection) ||
      selection.empty ||
      (!view.hasFocus() && !panel.contains(document.activeElement)) ||
      !applicable
    ) {
      panel.hidden = true;
      return;
    }
    const scroller = view.dom.closest(".main") ?? view.dom;
    const bounds = scroller.getBoundingClientRect();
    const viewport = {
      left: Math.max(0, bounds.left),
      right: Math.min(innerWidth, bounds.right),
      top: Math.max(0, bounds.top),
      bottom: Math.min(innerHeight, bounds.bottom),
    };
    const from = view.coordsAtPos(selection.from);
    const to = view.coordsAtPos(selection.to);
    const opening = panel.hidden;
    // 已打开时保持可见性，重新测量不能让键盘焦点从按钮上掉落。
    if (opening) panel.style.visibility = "hidden";
    panel.hidden = false;
    const position = placeSelectionToolbar(
      {
        left: Math.min(from.left, to.left),
        right: Math.max(from.right, to.right),
        top: from.top,
        bottom: to.bottom,
      },
      viewport,
      panel.getBoundingClientRect(),
    );
    panel.hidden = position === null;
    if (position !== null) {
      panel.style.left = `${position.left}px`;
      panel.style.top = `${position.top}px`;
      const buttons = enabledButtons();
      const active = buttons.find((button) => button === document.activeElement) ?? buttons[0];
      for (const button of buttons) button.tabIndex = button === active ? 0 : -1;
    }
    if (opening) panel.style.removeProperty("visibility");
  }

  function schedulePosition(): void {
    if (frame === 0) frame = requestAnimationFrame(updatePosition);
  }

  $effect(() => {
    // 文档事务与其他面板的展开只触发布局，不把测量结果写回编辑器。
    if (state.selection.empty || blocked) panel.hidden = true;
    schedulePosition();
  });

  function run(command: Command): void {
    command(view.state, view.dispatch, view);
  }

  function onKey(event: KeyboardEvent): void {
    if (isCompositionKey(event) || view.composing) return;
    if (event.altKey && event.key === "F10" && view.hasFocus()) {
      dismissed = null;
      cancelAnimationFrame(frame);
      updatePosition();
      if (!panel.hidden) {
        event.preventDefault();
        enabledButtons()[0]?.focus();
      }
      return;
    }
    if (panel.hidden) return;
    const inside = panel.contains(event.target instanceof Node ? event.target : null);
    if (event.key === "Escape" && (inside || view.hasFocus())) {
      event.preventDefault();
      event.stopPropagation();
      dismissed = view.state.selection;
      panel.hidden = true;
      if (inside) view.focus();
    } else if (inside && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const buttons = enabledButtons();
      const current = buttons.findIndex((button) => button === document.activeElement);
      const index =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? buttons.length - 1
            : (current + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[index]?.focus();
    }
  }

  $effect(() => {
    // 文档重载会替换 view，但可能复用工具条；监听和临时状态必须归属当前编辑器。
    const editorView = view;
    const events = new AbortController();
    const { signal } = events;
    dragging = false;
    dismissed = null;
    panel.hidden = true;
    const start = (): void => {
      dragging = true;
      dismissed = null;
      panel.hidden = true;
    };
    const finish = (): void => {
      dragging = false;
      schedulePosition();
    };
    editorView.dom.addEventListener("pointerdown", start, { signal });
    window.addEventListener("pointerup", finish, { signal });
    window.addEventListener("pointercancel", finish, { signal });
    window.addEventListener("scroll", schedulePosition, { capture: true, signal });
    window.addEventListener("resize", schedulePosition, { signal });
    document.addEventListener("focusin", schedulePosition, { signal });
    document.addEventListener("focusout", schedulePosition, { signal });
    document.addEventListener("keydown", onKey, { signal });
    schedulePosition();
    return () => {
      events.abort();
      cancelAnimationFrame(frame);
      frame = 0;
    };
  });
</script>

<div
  bind:this={panel}
  class="selection-formatting"
  role="toolbar"
  tabindex="-1"
  aria-label="选区格式"
  aria-keyshortcuts="Alt+F10"
  hidden
  onmousedown={(event) => event.preventDefault()}
>
  {#if applicable}
    <InlineFormatting {state} onFormat={run} />
    <span class="separator" aria-hidden="true"></span>
    <button
      class="reader-button link-button"
      type="button"
      aria-label="链接…"
      title="链接（⌘/Ctrl + K）"
      disabled={!state.selection.$from.sameParent(state.selection.$to)}
      onclick={() => {
        panel.hidden = true;
        onLink();
      }}
      ><svg class="reader-icon" viewBox="0 0 24 24" aria-hidden="true"
        ><path
          d="m10 13 4-4M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M13 8l1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0"
        /></svg
      ></button
    >
  {/if}
</div>

<style>
  .selection-formatting {
    position: fixed;
    z-index: 5;
    display: flex;
    align-items: center;
    gap: 0.2rem;
    padding: 0.3rem;
    color: var(--fg);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 0.65rem;
    box-shadow: 0 4px 18px var(--shadow);
  }
  .selection-formatting[hidden] {
    display: none;
  }
  .separator {
    width: 1px;
    height: 1.2rem;
    background: var(--border);
    margin: 0 0.15rem;
  }
  .link-button {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    padding: 0;
    border-color: transparent;
    background: transparent;
  }
</style>
