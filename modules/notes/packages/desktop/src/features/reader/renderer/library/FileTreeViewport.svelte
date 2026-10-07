<script lang="ts">
  import { onMount, tick, untrack, type Snippet } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import type { FileTreeRow } from "./file-tree";
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
    rows: FileTreeRow[];
    focused: string | null;
    dragging: string | null;
    selected: ReadonlySet<string>;
    expanded: ReadonlySet<string>;
    excerpts: ReadonlySet<string>;
    position: FileTreePosition | null;
    onPosition: (position: FileTreePosition | null) => void;
    onEmptyFocus: () => void;
    children: Snippet<[FileTreeRow]>;
  } = $props();
  let element: HTMLDivElement;
  let height = $state(0);
  let coarse = $state(false);
  let previousRows: readonly FileTreeRow[] = [];
  const positions = $derived(new Map(rows.map((row, index) => [row.node.path, index])));
  const geometry = $derived.by(() => {
    let top = 0;
    return rows.map((row) => {
      const height = excerpts.has(row.node.path) ? 46 : coarse ? 44 : 28;
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

  onMount(() => {
    const measure = () => {
      height = element.clientHeight;
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
    const index = previous.findIndex((row) => row.node.path === active.dataset.path);
    const survives = (row: FileTreeRow) => positions.has(row.node.path);
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
      if (next) void focusPath(next.node.path);
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
      row
        ? { path: row.node.path, offset: Math.max(0, element.scrollTop - geometry[index]!.top) }
        : null,
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
    return next === null
      ? null
      : (rows[Math.max(0, Math.min(rows.length - 1, next))]?.node.path ?? null);
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

<div
  class="file-tree"
  class:empty-tree={rows.length === 0}
  role="treegrid"
  aria-label="文件系统"
  aria-rowcount={rows.length}
  aria-colcount="1"
  aria-multiselectable="true"
  bind:this={element}
  onscroll={rememberPosition}
>
  <div class="extent" aria-hidden="true" style:height="{extent}px"></div>
  {#each visible as index (rows[index]!.node.path)}
    {@const row = rows[index]!}
    <div
      class="tree-row"
      role="row"
      aria-rowindex={index + 1}
      aria-level={row.depth + 1}
      aria-posinset={row.position}
      aria-setsize={row.siblings}
      aria-expanded={row.node.kind === "directory" ? expanded.has(row.node.path) : undefined}
      style:top="{geometry[index]!.top}px"
      style:height="{geometry[index]!.height}px"
      style:--tree-depth={row.depth}
    >
      <div role="gridcell" aria-colindex="1" aria-selected={selected.has(row.node.path)}>
        {@render children(row)}
      </div>
    </div>
  {/each}
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
</style>
