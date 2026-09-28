<script lang="ts">
  /**
   * 侧栏书签：按用户排列的顺序列出收藏的文件、文件夹、标题与搜索。
   * 失效目标置灰但保留，由用户决定移除；拖放或 Alt+↑/↓ 重排。
   */
  import { tick } from "svelte";
  import type { Bookmark } from "../../shared/api";
  import type { ReaderWorkspaceController } from "../workspace/state.svelte";
  import { bookmarkLabel, bookmarkMissing } from "./bookmarks";

  let {
    workspace,
    busy,
    onActivate,
  }: {
    workspace: ReaderWorkspaceController;
    /** 活动栏切换或另存期间不接受打开与重排。 */
    busy: boolean;
    /** 选中未失效的书签；打开方式按种类由文件栏决定。 */
    onActivate: (bookmark: Bookmark) => void;
  } = $props();

  const bookmarks = $derived(workspace.bookmarks);
  const rows = $derived(
    bookmarks.items.map((bookmark) => ({
      bookmark,
      label: bookmarkLabel(bookmark),
      missing: bookmarkMissing(bookmark, workspace.entries),
    })),
  );
  let list: HTMLUListElement | undefined = $state();
  let dragFrom = $state<number | null>(null);
  let dropBefore = $state<number | null>(null);

  function detail(bookmark: Bookmark, missing: boolean): string {
    if (missing) return "目标已不存在";
    return bookmark.kind === "search" ? "搜索" : bookmark.path;
  }

  /** 键盘焦点进入第一条书签；没有书签时不移动焦点。 */
  export function focusFirst(): void {
    list?.querySelector<HTMLButtonElement>("button.open")?.focus();
  }

  async function focusRow(index: number): Promise<void> {
    await tick();
    list?.querySelectorAll<HTMLButtonElement>("button.open")[index]?.focus();
  }

  function keydown(event: KeyboardEvent, index: number): void {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown") || busy) return;
    event.preventDefault();
    const before = event.key === "ArrowUp" ? index - 1 : index + 2;
    if (before < 0 || before > rows.length) return;
    void bookmarks
      .move(index, before)
      .then(() => focusRow(event.key === "ArrowUp" ? index - 1 : index + 1));
  }

  function dragover(event: DragEvent, index: number): void {
    if (dragFrom === null || busy || !(event.currentTarget instanceof HTMLElement)) return;
    event.preventDefault();
    const box = event.currentTarget.getBoundingClientRect();
    dropBefore = event.clientY > box.top + box.height / 2 ? index + 1 : index;
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  }

  function drop(event: DragEvent): void {
    event.preventDefault();
    const from = dragFrom;
    const before = dropBefore;
    dragFrom = null;
    dropBefore = null;
    if (from !== null && before !== null && !busy) void bookmarks.move(from, before);
  }
</script>

<div class="bookmarks">
  {#if bookmarks.error !== null}
    <p class="status" role="alert">{bookmarks.error}</p>
  {/if}
  {#if rows.length === 0}
    {#if bookmarks.error === null}
      <div class="empty">
        <strong>还没有书签</strong>
        <p>在文件右键菜单、搜索框或命令面板里收藏常用的笔记、文件夹、标题和搜索。</p>
      </div>
    {/if}
  {:else}
    <ul aria-label="书签" bind:this={list}>
      <!-- 书签文件允许手写，可能含重复目标，只有下标是唯一键。 -->
      {#each rows as { bookmark, label, missing }, index (index)}
        <li
          class:missing
          class:dragging={dragFrom === index}
          class:drop-before={dropBefore === index}
          class:drop-after={dropBefore === rows.length && index === rows.length - 1}
          draggable={!busy}
          ondragstart={(event) => {
            dragFrom = index;
            event.dataTransfer?.setData("text/plain", label);
            if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
          }}
          ondragend={() => {
            dragFrom = null;
            dropBefore = null;
          }}
          ondragover={(event) => dragover(event, index)}
          ondrop={drop}
        >
          <button
            type="button"
            class="open"
            title={missing ? `${label}（目标已不存在）` : label}
            aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
            aria-disabled={missing}
            disabled={busy}
            onclick={() => {
              if (!missing) onActivate(bookmark);
            }}
            onkeydown={(event) => keydown(event, index)}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true"
              >{#if bookmark.kind === "folder"}<path
                  d="M2.5 5a1 1 0 0 1 1-1h4l2 2h7a1 1 0 0 1 1 1v9h-15z"
                />{:else if bookmark.kind === "heading"}<path
                  d="M5 4v12M13 4v12M5 10h8"
                />{:else if bookmark.kind === "search"}<circle cx="8.5" cy="8.5" r="5" /><path
                  d="m12.5 12.5 4 4"
                />{:else}<path d="M5 2.5h6l4 4v11H5zM11 2.5v4h4" />{/if}</svg
            >
            <span class="text">
              <span class="name">{label}</span>
              <span class="detail">{detail(bookmark, missing)}</span>
            </span>
          </button>
          <button
            type="button"
            class="remove"
            aria-label="移除书签「{label}」"
            title="移除书签"
            onclick={() => void bookmarks.remove(bookmark)}
            ><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 6 8 8m0-8-8 8" /></svg></button
          >
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .bookmarks {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    padding: 0 0.55rem 0.65rem;
  }
  .status {
    color: var(--danger);
    font-size: 0.8rem;
    line-height: 1.5;
    padding: 0.5rem 0.25rem;
    margin: 0;
  }
  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li {
    display: flex;
    align-items: center;
    border-radius: 0.4rem;
    border-top: 2px solid transparent;
    border-bottom: 2px solid transparent;
  }
  li.drop-before {
    border-top-color: var(--accent);
  }
  li.drop-after {
    border-bottom-color: var(--accent);
  }
  li.dragging {
    opacity: 0.45;
  }
  li:hover {
    background: var(--selected);
  }
  button {
    font: inherit;
    color: inherit;
    border: 0;
    background: transparent;
    cursor: pointer;
    border-radius: 0.4rem;
  }
  button:disabled {
    cursor: default;
    opacity: 0.6;
  }
  .open {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 0.45rem;
    padding: 0.35rem 0.5rem;
    text-align: left;
    font-size: 0.83rem;
  }
  .open:focus-visible,
  .remove:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .missing .open {
    cursor: default;
    color: var(--muted);
  }
  .missing .name {
    text-decoration: line-through;
  }
  .text {
    display: flex;
    flex-direction: column;
    min-width: 0;
    gap: 0.1rem;
  }
  .name,
  .detail {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .detail {
    color: var(--muted);
    font-size: 0.7rem;
  }
  .remove {
    display: flex;
    padding: 0.3rem;
    color: var(--muted);
    opacity: 0;
  }
  li:hover .remove,
  li:focus-within .remove,
  .missing .remove {
    opacity: 1;
  }
  svg {
    width: 1rem;
    height: 1rem;
    flex-shrink: 0;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .open svg {
    color: var(--accent);
  }
  .missing .open svg {
    color: var(--muted);
  }
  .empty {
    color: var(--muted);
    font-size: 0.8rem;
    padding: 2rem 0.8rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    text-align: center;
  }
  .empty strong {
    font-weight: 500;
    color: var(--fg);
  }
  .empty p {
    margin: 0;
    max-width: 13rem;
    line-height: 1.6;
  }
</style>
