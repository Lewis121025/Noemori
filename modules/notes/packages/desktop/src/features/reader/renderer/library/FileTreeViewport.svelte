<script lang="ts">
  import { onMount, tick, untrack, type Snippet } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import type { WorkspaceTreeRow } from "./workspace-tree";
  import type { FileTreePosition } from "../../shared/file-browser";

  let {
    rows,
    focused,
    dragging,
    selected,
    expanded,
    excerpts,
    position,
    onPosition,
    onEmptyFocus,
    children,
  }: {
    rows: WorkspaceTreeRow[];
    focused: string | null;
    dragging: string | null;
    selected: ReadonlySet<string>;
    expanded: ReadonlySet<string>;
    excerpts: ReadonlySet<string>;
    position: FileTreePosition | null;
    onPosition: (position: FileTreePosition | null) => void;
    onEmptyFocus: () => void;
    children: Snippet<[WorkspaceTreeRow]>;
  } = $props();
  let element: HTMLDivElement;
  let labelElement: HTMLDivElement;
  let keyboardLabel = $state<{ path: string; text: string } | null>(null);
  let height = $state(0);
  let coarse = $state(false);
  let previousRows: readonly WorkspaceTreeRow[] = [];
  const positions = $derived(new Map(rows.map((row, index) => [row.key, index])));
  const geometry = $derived.by(() => {
    let top = 0;
    return rows.map((row) => {
      const height = excerpts.has(row.key) ? 48 : coarse ? 44 : 30;
      const item = { top, height };
      top += height;
      return item;
    });
  });
  const extent = $derived((geometry.at(-1)?.top ?? 0) + (geometry.at(-1)?.height ?? 0));
  const scrollTop = $derived.by(() => {
    const row = position === null ? undefined : geometry[positions.get(position.path) ?? 0];
    return row ? row.top + Math.min(position?.offset ?? 0, row.height) : 0;
  });
  function rowAt(offset: number): number {
    let low = 0,
      high = geometry.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (geometry[mid]!.top + geometry[mid]!.height <= offset) low = mid + 1;
      else high = mid;
    }
    return Math.min(low, Math.max(0, geometry.length - 1));
  }
  const visible = $derived.by(() => {
    const first = Math.max(0, rowAt(scrollTop) - 8);
    const last = Math.min(rows.length, rowAt(scrollTop + height) + 9);
    const indexes = new SvelteSet(
      Array.from({ length: last - first }, (_, index) => first + index),
    );
    for (const path of [focused, dragging]) {
      const index = path === null ? undefined : positions.get(path);
      if (index !== undefined) indexes.add(index);
    }
    return [...indexes].sort((a, b) => a - b);
  });

  // 原生 title 仅响应悬停；键盘浏览被截断的名称时也需要看到完整路径。
  function showKeyboardLabel(event: FocusEvent): void {
    const button = event.target;
    if (!(button instanceof HTMLButtonElement) || !button.matches(":focus-visible")) return;
    const name = button.querySelector<HTMLElement>(".name");
    keyboardLabel = button.dataset.path && button.title && name && name.scrollWidth > name.clientWidth
      ? { path: button.dataset.path, text: button.title }
      : null;
  }
  $effect(() => {
    const label = keyboardLabel;
    const button = label && positions.has(label.path)
      ? Array.from(element.querySelectorAll<HTMLButtonElement>("button[data-path]"))
          .find((button) => button.dataset.path === label.path)
      : null;
    if (!label || !button?.isConnected) {
      labelElement.hidePopover();
      return;
    }
    labelElement.showPopover();
    const bounds = button.getBoundingClientRect();
    const hint = labelElement.getBoundingClientRect();
    labelElement.style.left = `${Math.max(8, Math.min(bounds.left, window.innerWidth - hint.width - 8))}px`;
    labelElement.style.top = `${Math.max(8, Math.min(bounds.bottom + 5, window.innerHeight - hint.height - 8))}px`;
  });

  onMount(() => {
    const measure = () => {
      height = element.clientHeight;
      keyboardLabel = null;
    };
    const pointer = matchMedia("(pointer: coarse)");
    const updatePointer = () => {
      coarse = pointer.matches;
    };
    updatePointer();
    measure();
    pointer.addEventListener("change", updatePointer);
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
      pointer.removeEventListener("change", updatePointer);
    };
  });
  $effect(() => {
    element.scrollTop = scrollTop;
    untrack(() => {
      if (rows.length > 0 && height > 0) rememberPosition();
    });
  });
  $effect(() => {
    // 高度变化只核对浏览器的实际位置，不能回放尚未收到 scroll 事件前的旧锚点。
    if (rows.length > 0 && height > 0) untrack(rememberPosition);
  });
  $effect.pre(() => {
    const previous = previousRows;
    previousRows = rows;
    const active = document.activeElement;
    if (
      !(active instanceof HTMLButtonElement) ||
      !element?.contains(active) ||
      !active.dataset.path ||
      positions.has(active.dataset.path)
    )
      return;
    const index = previous.findIndex((row) => row.key === active.dataset.path);
    const survives = (row: WorkspaceTreeRow) => positions.has(row.key);
    const next =
      previous.slice(index + 1).find(survives) ??
      previous.slice(0, index).findLast(survives) ??
      rows[0];
    let cancelled = false;
    void tick().then(() => {
      if (
        cancelled ||
        !element.isConnected ||
        (document.activeElement !== active && document.activeElement !== document.body)
      )
        return;
      if (next) void focusPath(next.key);
      else onEmptyFocus();
    });
    return () => {
      cancelled = true;
    };
  });
  function rememberPosition(): void {
    const index = rowAt(element.scrollTop),
      row = rows[index];
    onPosition(
      row ? { path: row.key, offset: Math.max(0, element.scrollTop - geometry[index]!.top) } : null,
    );
  }
  /**
   * 从完整可见树序列解析上下键和首尾键，折叠分支不参与。
   * @returns 目标路径；其他按键或空树返回 null，不改变选择。
   */
  export function nextPath(path: string, key: string): string | null {
    const index = positions.get(path) ?? 0;
    const next =
      key === "Home"
        ? 0
        : key === "End"
          ? rows.length - 1
          : key === "ArrowDown"
            ? index + 1
            : key === "ArrowUp"
              ? index - 1
              : null;
    return next === null ? null : (rows[Math.max(0, Math.min(rows.length - 1, next))]?.key ?? null);
  }
  /**
   * 先挂载目标行再交接焦点；变高的正文摘录不影响滚动锚点。
   * @param path 当前可见树中的路径；不存在或已经卸载时不操作。
   * @returns DOM 更新完成后兑现；传播 Svelte 更新异常。
   */
  export async function focusPath(path: string): Promise<void> {
    const index = positions.get(path),
      viewport = element;
    if (index === undefined || !viewport?.isConnected) return;
    const row = geometry[index]!;
    if (row.top < viewport.scrollTop) viewport.scrollTop = row.top;
    else if (row.top + row.height > viewport.scrollTop + viewport.clientHeight)
      viewport.scrollTop = Math.max(0, row.top + row.height - viewport.clientHeight);
    rememberPosition();
    await tick();
    if (viewport !== element || !viewport.isConnected) return;
    Array.from(viewport.querySelectorAll<HTMLButtonElement>("button[data-path]"))
      .find((button) => button.dataset.path === path)
      ?.focus({ preventScroll: true });
  }
</script>

<!-- 网格通过行按钮管理唯一游走焦点，容器只接收冒泡事件，不额外占用 Tab 入口。 -->
<!-- svelte-ignore a11y_interactive_supports_focus -->
<div
  class="file-tree"
  class:empty-tree={rows.length === 0}
  role="treegrid"
  aria-label="文件与对话"
  aria-rowcount={rows.length}
  aria-colcount="1"
  aria-multiselectable="true"
  bind:this={element}
  onfocusin={showKeyboardLabel}
  onfocusout={() => (keyboardLabel = null)}
  onkeydown={(event) => {
    if (event.key === "Escape") keyboardLabel = null;
  }}
  onscroll={() => {
    keyboardLabel = null;
    rememberPosition();
  }}
>
  <div class="extent" aria-hidden="true" style:height="{extent}px"></div>
  {#each visible as index (rows[index]!.key)}
    {@const row = rows[index]!}
    <div
      class="tree-row"
      role="row"
      aria-rowindex={index + 1}
      aria-level={row.depth + 1}
      aria-posinset={row.position}
      aria-setsize={row.siblings}
      aria-expanded={row.children.length > 0 || row.kind === "directory"
        ? expanded.has(row.key)
        : undefined}
      style:top="{geometry[index]!.top}px"
      style:height="{geometry[index]!.height}px"
      style:--tree-depth={row.depth}
    >
      <div role="gridcell" aria-colindex="1" aria-selected={selected.has(row.key)}>
        {@render children(row)}
      </div>
    </div>
  {/each}
  <div class="reader-popover keyboard-label" role="tooltip" popover="manual" bind:this={labelElement}>
    {keyboardLabel?.text ?? ""}
  </div>
</div>

<style>
  .file-tree {
    position: relative;
    flex: 1 1 0;
    min-height: 28px;
    overflow: auto;
    overflow-anchor: none;
  }
  .empty-tree {
    flex: 0;
    min-height: 0;
  }
  .extent {
    pointer-events: none;
  }
  .tree-row {
    position: absolute;
    left: 8px;
    right: 8px;
    min-width: 0;
  }
  .tree-row > div {
    height: 100%;
    min-width: 0;
  }
  .keyboard-label {
    position: fixed;
    inset: auto;
    margin: 0;
    max-width: min(360px, calc(100vw - 16px));
    padding: 7px 10px;
    font-size: 12px;
    overflow-wrap: anywhere;
    pointer-events: none;
  }
</style>
