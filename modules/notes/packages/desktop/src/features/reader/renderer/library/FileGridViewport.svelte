<script lang="ts">
  import { onMount, tick, untrack, type Snippet } from "svelte";
  import type { FileTreeRow } from "./file-tree";
  import type { FileTreePosition } from "../../shared/file-browser";
  import { fileTreeWindow } from "./file-tree-window";
  import { gridTarget } from "./file-grid";

  let {
    rows,
    focused,
    dragging,
    selected,
    position,
    onPosition,
    onEmptyFocus,
    children,
  }: {
    rows: FileTreeRow[];
    focused: string | null;
    dragging: string | null;
    selected: ReadonlySet<string>;
    position: FileTreePosition | null;
    onPosition: (position: FileTreePosition | null) => void;
    onEmptyFocus: () => void;
    children: Snippet<[FileTreeRow]>;
  } = $props();
  const rowHeight = 148;
  let element: HTMLDivElement;
  let columns = $state(1);
  let height = $state(0);
  let previousRows: readonly FileTreeRow[] = [];
  const positions = $derived(new Map(rows.map((row, index) => [row.node.path, index])));
  const rowCount = $derived(Math.ceil(rows.length / columns));
  const scrollTop = $derived(
    position === null
      ? 0
      : Math.floor((positions.get(position.path) ?? 0) / columns) * rowHeight +
          Math.min(position.offset, rowHeight),
  );
  const visibleRows = $derived(
    fileTreeWindow(rowCount, scrollTop, height, rowHeight, [
      Math.floor((positions.get(focused ?? "") ?? -columns) / columns),
      Math.floor((positions.get(dragging ?? "") ?? -columns) / columns),
    ]),
  );

  onMount(() => {
    const measure = () => {
      columns = Math.max(1, Math.floor((element.clientWidth - 16) / 144));
      height = element.clientHeight;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
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
    const index = Math.floor(element.scrollTop / rowHeight) * columns;
    const row = rows[index];
    onPosition(row ? { path: row.node.path, offset: element.scrollTop % rowHeight } : null);
  }
  /**
   * 根据已测量的列数解析键盘目标，不改变选择或焦点。
   * @param path 当前文件的库内路径。
   * @param key 方向键、Home 或 End；其他按键交还调用方。
   * @returns 目标路径；空网格或未知按键返回 null，不抛出异常。
   */
  export function nextPath(path: string, key: string): string | null {
    const index = gridTarget(positions.get(path) ?? 0, rows.length, columns, key);
    return index === null ? null : (rows[index]?.node.path ?? null);
  }
  /**
   * 挂载目标所在行并滚入视口后交接焦点，避免聚焦被虚拟化卸载的元素。
   * @param path 目标文件的库内路径；已消失或视口已卸载时不操作。
   * @returns DOM 更新与焦点交接完成后兑现；传播 Svelte 更新异常。
   */
  export async function focusPath(path: string): Promise<void> {
    const index = positions.get(path);
    const viewport = element;
    if (index === undefined || !viewport?.isConnected) return;
    const top = Math.floor(index / columns) * rowHeight;
    if (top < viewport.scrollTop) viewport.scrollTop = top;
    else if (top + rowHeight > viewport.scrollTop + viewport.clientHeight)
      viewport.scrollTop = Math.max(0, top + rowHeight - viewport.clientHeight);
    rememberPosition();
    await tick();
    if (element !== viewport || !viewport.isConnected) return;
    Array.from(viewport.querySelectorAll<HTMLButtonElement>("button[data-path]"))
      .find((button) => button.dataset.path === path)
      ?.focus({ preventScroll: true });
  }
</script>

<div
  class="file-grid"
  class:empty-grid={rows.length === 0}
  role="grid"
  aria-label="文件系统"
  aria-rowcount={rowCount}
  aria-colcount={columns}
  aria-multiselectable="true"
  bind:this={element}
  onscroll={rememberPosition}
>
  <div class="extent" aria-hidden="true" style:height="{rowCount * rowHeight}px"></div>
  {#each visibleRows as rowIndex (rowIndex)}
    <div
      class="grid-row"
      role="row"
      aria-rowindex={rowIndex + 1}
      style:top="{rowIndex * rowHeight}px"
      style:grid-template-columns="repeat({columns}, minmax(0, 1fr))"
    >
      {#each rows.slice(rowIndex * columns, (rowIndex + 1) * columns) as row, column (row.node.path)}
        <div role="gridcell" aria-colindex={column + 1} aria-selected={selected.has(row.node.path)}>
          {@render children(row)}
        </div>
      {/each}
    </div>
  {/each}
</div>

<style>
  .file-grid {
    position: relative;
    flex: 1 1 0;
    min-height: 148px;
    overflow: auto;
    overflow-anchor: none;
    padding: 0 8px;
  }
  .empty-grid {
    flex: 0;
    min-height: 0;
  }
  .extent {
    pointer-events: none;
  }
  .grid-row {
    position: absolute;
    left: 8px;
    right: 8px;
    height: 148px;
    display: grid;
    gap: 12px;
  }
  .grid-row > div {
    min-width: 0;
  }
</style>
