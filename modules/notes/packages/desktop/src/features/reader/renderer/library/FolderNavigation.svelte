<script lang="ts">
  import { onMount, tick, untrack } from "svelte";
  import type { ReaderWorkspaceController } from "../workspace/state.svelte";
  import {
    ancestorDirectories,
    buildFileTree,
    visibleFileRows,
    type FileTreeRow,
  } from "./file-tree";
  import { fileTreeWindow } from "./file-tree-window";
  import { isCompositionKey } from "../editor/composition";

  let {
    workspace,
    onNavigate,
  }: {
    workspace: ReaderWorkspaceController;
    /** 目录切换交给文件浏览器结束临时编辑，再由外壳处理窄屏抽屉。 */
    onNavigate: (path: string) => void;
  } = $props();
  const browser = $derived(workspace.fileTree);
  const directory = $derived(browser.state.browse?.directory ?? "");
  const busy = $derived(
    !browser.ready || workspace.switching || workspace.copying || workspace.isComposing,
  );
  const tree = $derived(
    buildFileTree(
      workspace.entries.filter((entry) => entry.kind === "directory" && !entry.recoveryOnly),
    ),
  );
  const expanded = $derived(new Set(browser.state.expanded));
  const rows = $derived(visibleFileRows(tree, expanded));
  const positions = $derived(new Map(rows.map((row, index) => [row.node.path, index])));
  const rowHeight = 32;
  let viewport: HTMLDivElement;
  let rootButton: HTMLButtonElement;
  let height = $state(0);
  let focused = $state<string | null>(null);
  let removedFocus = $state<string | null>(null);
  const focusable = $derived(
    positions.has(focused ?? "")
      ? focused
      : positions.has(directory)
        ? directory
        : rows[0]?.node.path,
  );
  const scrollTop = $derived.by(() => {
    const anchor = browser.state.navigationScroll;
    if (!anchor) return 0;
    const path = [anchor.path, ...ancestorDirectories(anchor.path).reverse()].find((path) =>
      positions.has(path),
    );
    return (positions.get(path ?? "") ?? 0) * rowHeight + Math.min(anchor.offset, rowHeight - 1);
  });
  const visible = $derived(
    fileTreeWindow(rows.length, scrollTop, height, rowHeight, [
      positions.get(focusable ?? "") ?? -1,
    ]).flatMap((index) => {
      const row = rows[index];
      return row === undefined ? [] : [{ row, index }];
    }),
  );

  // 从网格、面包屑或恢复会话进入深层目录时显露祖先；手动折叠不改变当前浏览位置。
  $effect(() => {
    const path = directory;
    if (!browser.ready) return;
    untrack(() =>
      browser.update({
        expanded: [...new Set([...browser.state.expanded, ...ancestorDirectories(path)])],
      }),
    );
  });
  onMount(() => {
    const measure = () => {
      height = viewport.clientHeight;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  });
  $effect(() => {
    viewport.scrollTop = scrollTop;
    if (height > 0) untrack(rememberPosition);
  });
  $effect.pre(() => {
    const available = positions;
    const active = document.activeElement;
    // 禁用操作中的按钮可能先让原生焦点回到 body，仍需保留随后被删除条目的归属。
    const path =
      active instanceof HTMLElement && viewport?.contains(active)
        ? active.dataset.directory
        : active === document.body
          ? focused
          : null;
    if (path === undefined || path === null || available.has(path)) return;
    removedFocus =
      ancestorDirectories(path)
        .reverse()
        .find((path) => available.has(path)) ?? "";
  });
  // 文件事务期间按钮不可聚焦，等待操作释放门禁再交还焦点，且不抢走用户新选择的焦点。
  $effect(() => {
    const path = removedFocus;
    if (path === null || busy) return;
    untrack(() => {
      removedFocus = null;
      void tick().then(() => {
        if (viewport.isConnected && document.activeElement === document.body)
          void focusDirectory(path);
      });
    });
  });
  function rememberPosition(): void {
    const row = rows[Math.floor(viewport.scrollTop / rowHeight)];
    browser.update({
      navigationScroll: row
        ? { path: row.node.path, offset: viewport.scrollTop % rowHeight }
        : null,
    });
  }
  function navigate(path: string): void {
    if (busy) return;
    onNavigate(path);
  }
  function toggle(path: string): void {
    if (busy) return;
    browser.update({
      expanded: expanded.has(path)
        ? browser.state.expanded.filter((item) => item !== path)
        : [...browser.state.expanded, path],
    });
  }
  async function focusDirectory(path: string): Promise<void> {
    if (path === "") {
      rootButton.focus();
      return;
    }
    const index = positions.get(path);
    if (index === undefined) return;
    focused = path;
    const top = index * rowHeight;
    if (top < viewport.scrollTop) viewport.scrollTop = top;
    else if (top + rowHeight > viewport.scrollTop + height)
      viewport.scrollTop = Math.max(0, top + rowHeight - height);
    rememberPosition();
    await tick();
    if (!viewport.isConnected) return;
    Array.from(viewport.querySelectorAll<HTMLButtonElement>("[data-directory]"))
      .find((button) => button.dataset.directory === path)
      ?.focus({ preventScroll: true });
  }
  function keydown(event: KeyboardEvent, row: FileTreeRow): void {
    if (
      busy ||
      isCompositionKey(event) ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    )
      return;
    const index = positions.get(row.node.path);
    if (index === undefined) return;
    let next: string | undefined;
    if (event.key === "ArrowDown") next = rows[Math.min(index + 1, rows.length - 1)]?.node.path;
    else if (event.key === "ArrowUp") next = rows[Math.max(index - 1, 0)]?.node.path;
    else if (event.key === "Home") next = rows[0]?.node.path;
    else if (event.key === "End") next = rows.at(-1)?.node.path;
    else if (event.key === "ArrowRight" && row.node.children.length > 0) {
      if (!expanded.has(row.node.path)) toggle(row.node.path);
      else next = row.node.children[0]?.path;
    } else if (event.key === "ArrowLeft") {
      if (expanded.has(row.node.path) && row.node.children.length > 0) toggle(row.node.path);
      else next = row.parent ?? "";
    } else return;
    event.preventDefault();
    if (next !== undefined) void focusDirectory(next);
  }
</script>

<nav class="folder-navigation" aria-label="文件夹导航">
  <h2>文件夹</h2>
  <button
    class="folder-root"
    type="button"
    bind:this={rootButton}
    data-directory=""
    aria-current={directory === "" ? "location" : undefined}
    disabled={busy}
    onfocus={() => (focused = null)}
    onclick={() => navigate("")}
  >
    <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 3h14v14H3zM3 7h14M7 7v10" /></svg>
    <span>全部文件</span>
  </button>
  <div
    class="folder-tree"
    role="tree"
    aria-label="笔记库文件夹"
    bind:this={viewport}
    onscroll={rememberPosition}
  >
    <div class="extent" aria-hidden="true" style:height="{rows.length * rowHeight}px"></div>
    {#each visible as { row, index } (row.node.path)}
      <button
        class="folder-row"
        type="button"
        role="treeitem"
        data-directory={row.node.path}
        aria-label={row.node.name}
        aria-level={row.depth + 1}
        aria-posinset={row.position}
        aria-setsize={row.siblings}
        aria-expanded={row.node.children.length > 0 ? expanded.has(row.node.path) : undefined}
        aria-current={directory === row.node.path ? "location" : undefined}
        aria-selected={directory === row.node.path}
        title={row.node.path}
        tabindex={focusable === row.node.path ? 0 : -1}
        disabled={busy}
        style:top="{index * rowHeight}px"
        style:padding-left="{8 + row.depth * 14}px"
        onfocus={() => (focused = row.node.path)}
        onkeydown={(event) => keydown(event, row)}
        onclick={(event) => {
          if (
            row.node.children.length > 0 &&
            event.target instanceof Element &&
            event.target.closest(".disclosure")
          )
            toggle(row.node.path);
          else navigate(row.node.path);
        }}
      >
        <span class="disclosure" class:expanded={expanded.has(row.node.path)} aria-hidden="true">
          {#if row.node.children.length > 0}<svg viewBox="0 0 16 16"><path d="m6 4 4 4-4 4" /></svg
            >{/if}
        </span>
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2.5 5h5l2 2h8v9h-15z" /></svg>
        <span class="name">{row.node.name}</span>
      </button>
    {/each}
    {#if rows.length === 0}<p class="empty">暂无子文件夹</p>{/if}
  </div>
</nav>

<style>
  .folder-navigation {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    padding: 12px 0;
  }
  h2 {
    margin: 0 16px 8px;
    font-size: 0.7rem;
    font-weight: 500;
    color: var(--muted);
  }
  .folder-tree {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow: auto;
    overflow-anchor: none;
  }
  .extent {
    pointer-events: none;
  }
  .folder-root,
  .folder-row {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 32px;
    padding: 0 8px;
    color: var(--fg);
    background: transparent;
    border: 0;
    border-radius: 6px;
    text-align: left;
    font-size: 0.8rem;
    cursor: pointer;
  }
  .folder-root {
    flex: 0 0 32px;
    margin: 0 8px 6px;
  }
  .folder-row {
    position: absolute;
    left: 8px;
    right: 8px;
    width: calc(100% - 16px);
  }
  .folder-root:hover,
  .folder-row:hover {
    background: var(--selected);
  }
  [aria-current="location"] {
    background: var(--selected);
    font-weight: 600;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  svg {
    width: 18px;
    height: 18px;
    flex-shrink: 0;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .disclosure {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 12px;
    height: 100%;
  }
  .disclosure svg {
    width: 12px;
    height: 12px;
  }
  .disclosure.expanded svg {
    transform: rotate(90deg);
  }
  .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .empty {
    margin: 12px 16px;
    font-size: 0.75rem;
    color: var(--muted);
  }
</style>
