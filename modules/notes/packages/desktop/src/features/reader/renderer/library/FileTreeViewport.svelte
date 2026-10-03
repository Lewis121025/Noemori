<script lang="ts">
  import { onMount, tick, untrack, type Snippet } from "svelte";
  import { parentDirectory, type FileTreeRow } from "./file-tree";
  import { fileTreeWindow } from "./file-tree-window";
  import type { FileTreePosition } from "../../shared/file-browser";

  let {
    rows,
    focusable,
    dragging,
    position,
    onPosition,
    onEmptyFocus,
    children,
    label = "笔记库目录",
    multiselectable = true,
  }: {
    rows: FileTreeRow[];
    focusable: string | null;
    dragging: string | null;
    /** 完整目录与临时搜索各自持有滚动位置，卸载视口不会丢失浏览上下文。 */
    position: FileTreePosition | null;
    onPosition: (position: FileTreePosition | null) => void;
    /** 正在浏览的目录变空时，将键盘交还文件栏入口；其他控件的焦点不受影响。 */
    onEmptyFocus: () => void;
    children: Snippet<[FileTreeRow]>;
    /** 导航侧栏与资料管理使用不同名称，辅助技术可区分两个目录入口。 */
    label?: string;
    /** 导航仅打开单个文件，资料管理允许多选。 */
    multiselectable?: boolean;
  } = $props();
  const descriptionId = $props.id();
  let element: HTMLUListElement;
  let measure: HTMLLIElement;
  let height = $state(0);
  let rowHeight = $state(35.2);
  let previousRows: readonly FileTreeRow[] = [];
  const positions = $derived(new Map(rows.map((row, index) => [row.node.path, index])));
  const scrollTop = $derived.by(() => {
    if (position === null) return 0;
    let path = position.path;
    while (path !== "") {
      const index = positions.get(path);
      if (index !== undefined)
        return (
          index * rowHeight + (path === position.path ? Math.min(position.offset, rowHeight) : 0)
        );
      // 折叠只隐藏后代；锚点回到最近仍可见的父目录，不跳到整个列表开头。
      path = parentDirectory(path);
    }
    return 0;
  });
  const indices = $derived(
    fileTreeWindow(rows.length, scrollTop, height, rowHeight, [
      positions.get(focusable ?? "") ?? -1,
      positions.get(dragging ?? "") ?? -1,
    ]),
  );

  onMount(() => {
    function measureViewport(entries: ResizeObserverEntry[]): void {
      height = element.clientHeight;
      // 深滚动的屏幕坐标会损失小数精度；布局尺寸不受位置影响，避免误差乘以数千行。
      const measured = entries.find((entry) => entry.target === measure)?.borderBoxSize[0]
        ?.blockSize;
      if (measured !== undefined && measured > 0) rowHeight = measured;
    }
    height = element.clientHeight;
    const observer = new ResizeObserver(measureViewport);
    observer.observe(element);
    observer.observe(measure);
    return () => observer.disconnect();
  });

  $effect(() => {
    element.scrollTop = scrollTop;
    // 浏览器会夹取短列表和列表末尾的滚动值，夹取到原位置时不会触发 scroll。
    // 必须记下实际位置，否则下一次展开会重新执行上次未生效的滚动请求。
    if (rows.length > 0 && height > 0 && element.clientHeight > 0) untrack(rememberPosition);
  });

  $effect.pre(() => {
    const previous = previousRows;
    previousRows = rows;
    const active = document.activeElement;
    // 原位编辑器负责自己的提交和焦点交接，目录导航只接续消失的条目按钮。
    if (
      !(active instanceof HTMLButtonElement) ||
      active.getAttribute("role") !== "treeitem" ||
      !element?.contains(active)
    )
      return;
    const path = active.dataset.path;
    if (path === undefined || positions.has(path)) return;
    const index = previous.findIndex((row) => row.node.path === path);
    const survives = (row: FileTreeRow) => positions.has(row.node.path);
    const next =
      previous.slice(index + 1).find(survives) ??
      previous.slice(0, index).findLast(survives) ??
      rows[0];
    let cancelled = false;
    // 在旧节点卸载前确认焦点归属；等待期间用户转去其他控件时不能抢回焦点。
    void tick().then(() => {
      if (
        cancelled ||
        !element.isConnected ||
        (document.activeElement !== active && document.activeElement !== document.body)
      )
        return;
      if (next === undefined) onEmptyFocus();
      else void focusPath(next.node.path);
    });
    return () => {
      cancelled = true;
    };
  });

  function rememberPosition(): void {
    const index = Math.floor(element.scrollTop / rowHeight);
    const row = rows[index];
    onPosition(
      row === undefined
        ? null
        : { path: row.node.path, offset: element.scrollTop - index * rowHeight },
    );
  }

  /**
   * 将完整目录中的条目滚入视口，挂载后再交还键盘焦点。
   * @param path 可见目录模型中的完整相对路径；已消失的条目不产生操作。
   */
  export async function focusPath(path: string): Promise<void> {
    const button = await scrollToPath(path);
    button?.focus({ preventScroll: true });
  }

  /**
   * 仅在条目超出视口时滚动，文档切换不抢走编辑器焦点。
   * @param path 可见模型中的完整相对路径；条目消失或视口卸载时不操作。
   * @returns 条目定位完成的 Promise，不改变键盘焦点。
   */
  export async function revealPath(path: string): Promise<void> {
    await scrollToPath(path);
  }

  async function scrollToPath(path: string): Promise<HTMLButtonElement | null> {
    const viewport = element;
    const index = positions.get(path);
    if (index === undefined || !viewport?.isConnected) return null;
    const top = index * rowHeight;
    const bottom = top + rowHeight;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (bottom > element.scrollTop + element.clientHeight)
      element.scrollTop = bottom - element.clientHeight;
    rememberPosition();
    await tick();
    // 搜索、标签切换或卸载可能发生在布局等待期间，焦点请求只属于发起时的视口。
    if (element !== viewport || !viewport.isConnected) return null;
    const button = Array.from(viewport.querySelectorAll<HTMLButtonElement>("[data-path]")).find(
      (button) => button.dataset.path === path,
    );
    if (!button) return null;
    // 模型用于先挂载远处行；浏览器会量化滚动偏移，最后以真实按钮边界校正。
    const bounds = viewport.getBoundingClientRect();
    const row = button.getBoundingClientRect();
    if (row.top < bounds.top) viewport.scrollTop -= Math.ceil(bounds.top - row.top);
    else if (row.bottom > bounds.bottom)
      viewport.scrollTop += Math.ceil(row.bottom - bounds.bottom);
    rememberPosition();
    return button;
  }
</script>

<span id={descriptionId} hidden>共 {rows.length} 个文件和文件夹，可用方向键浏览。</span>
<ul
  class="list-body"
  class:empty-tree={rows.length === 0}
  role="tree"
  aria-label={label}
  aria-describedby={descriptionId}
  bind:this={element}
  onscroll={rememberPosition}
  aria-multiselectable={multiselectable}
>
  <li class="measure" aria-hidden="true" bind:this={measure}></li>
  <li class="extent" aria-hidden="true" style:height="{rows.length * rowHeight}px"></li>
  {#each indices as index (rows[index]!.node.path)}
    <li class="tree-row" role="none" style:top="{index * rowHeight}px">
      {@render children(rows[index]!)}
    </li>
  {/each}
</ul>

<style>
  .list-body {
    --file-row-height: 2.2rem;
    position: relative;
    list-style: none;
    margin: 0;
    overflow: auto;
    /* 虚拟内容的总高度只决定滚动范围，不能参与侧栏头部的弹性压缩。 */
    flex: 1 1 0;
    /* 窄窗口仍须容纳一整行，否则任何滚动位置都无法完整显示键盘焦点。 */
    min-height: var(--file-row-height);
    padding: 0 0.55rem 0.75rem;
    overflow-anchor: none;
  }
  .measure {
    position: absolute;
    width: 0;
    height: var(--file-row-height);
    visibility: hidden;
    pointer-events: none;
  }
  .extent {
    pointer-events: none;
  }
  .tree-row {
    position: absolute;
    left: 0.55rem;
    right: 0.55rem;
    height: var(--file-row-height);
  }
  .empty-tree {
    flex: 0;
    min-height: 0;
    padding: 0;
  }
</style>
