<script lang="ts">
  /** 编辑模式常驻工具栏；所有命令直接使用所属编辑器选区，不复制文档状态。 */
  import { onMount, tick } from "svelte";
  import type { Command, EditorState } from "prosemirror-state";
  import type { EditorView } from "prosemirror-view";
  import { undo, redo } from "prosemirror-history";
  import { writingCommands } from "../writing";
  import { inTable, leaveTable, tableCommands } from "../table/table";
  import InlineFormatting from "./InlineFormatting.svelte";
  import { canInsertAttachment } from "../attachments/attachments";
  import { canInsertWebPage } from "../webpage/insert";

  let {
    id = "editor-formatting",
    view,
    state: editorState,
    onLink,
    onAttachment,
    onWebPage,
    sidebar = false,
    onShowTools,
  }: {
    /** 工具栏 DOM id；各分栏身份独立，操作始终作用于所属编辑器。 */
    id?: string;
    view: EditorView;
    state: EditorState;
    onLink: () => void;
    onAttachment: () => void;
    /** 打开所属编辑器的网页插入对话框；静态格式测试可不提供。 */
    onWebPage?: () => void;
    /** 侧栏固定使用换行布局，基础格式不随栏宽藏入菜单。 */
    sidebar?: boolean;
    /** 快捷键进入工具时先展开所属侧栏，不新建另一组选区按钮。 */
    onShowTools?: () => void;
  } = $props();
  const blocks = [
    { name: "paragraph", label: "正文" },
    { name: "heading1", label: "标题 1" },
    { name: "heading2", label: "标题 2" },
    { name: "heading3", label: "标题 3" },
    { name: "heading4", label: "标题 4" },
    { name: "heading5", label: "标题 5" },
    { name: "heading6", label: "标题 6" },
    { name: "codeBlock", label: "代码块" },
  ] as const;
  const structures = [
    {
      name: "bulletList",
      label: "项目列表",
      icon: "M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01",
    },
    {
      name: "orderedList",
      label: "编号列表",
      icon: "M10 6h10M10 12h10M10 18h10M3 4h1v5M3 9h3M3 14c3-2 4 1 1 3l-1 2h3",
    },
    { name: "taskList", label: "任务列表", icon: "m3 6 2 2 3-4M11 6h9M11 16h9M3 13h5v5H3z" },
    { name: "quote", label: "引用", icon: "M5 5v14M10 7h10M10 12h10M10 17h6" },
  ] as const;
  const tableStructure = [
    { name: "addRow", label: "下方插入行" },
    { name: "deleteRow", label: "删除当前行" },
    { name: "addColumn", label: "右侧插入列" },
    { name: "deleteColumn", label: "删除当前列" },
  ] as const;
  const alignments = [
    { name: "alignLeft", value: "left", label: "列左对齐", icon: "M4 6h16M4 12h10M4 18h16" },
    { name: "alignCenter", value: "center", label: "列居中对齐", icon: "M4 6h16M7 12h10M4 18h16" },
    { name: "alignRight", value: "right", label: "列右对齐", icon: "M4 6h16M10 12h10M4 18h16" },
  ] as const;
  const table = $derived(inTable(editorState));
  const block = $derived(
    editorState.selection.$from.parent.type.name === "heading"
      ? `heading${String(editorState.selection.$from.parent.attrs["level"])}`
      : editorState.selection.$from.parent.type.name === "code_block"
        ? "codeBlock"
        : "paragraph",
  );

  function run(command: Command): void {
    command(view.state, view.dispatch, view);
    view.focus();
  }
  function setBlock(value: string): void {
    const option = blocks.find((item) => item.name === value);
    if (option) run(writingCommands[option.name]);
  }
  let width = $state(0);
  let panel: HTMLDivElement;
  onMount(() => {
    const observer = new ResizeObserver(() => {
      width = panel.clientWidth;
    });
    observer.observe(panel);
    width = panel.clientWidth;
    return () => observer.disconnect();
  });
  let insertMenu: HTMLDivElement;
  let moreMenu: HTMLDivElement;
  const compact = $derived(sidebar || width < 620);
  const minimal = $derived(!sidebar && width < 360);
  function closeMenus(): void {
    insertMenu.hidePopover();
    moreMenu.hidePopover();
  }
  function action(command: Command): void {
    closeMenus();
    run(command);
  }

  function focusTools(event: KeyboardEvent): void {
    if (event.isComposing || view.isDestroyed || view.composing) return;
    if (event.key === "Escape" && panel.contains(document.activeElement)) {
      event.preventDefault();
      event.stopPropagation();
      view.focus();
      return;
    }
    if (!view.hasFocus()) return;
    if (event.altKey && event.key === "F10") {
      event.preventDefault();
      onShowTools?.();
      void tick().then(() => {
        if (!panel.isConnected) return;
        panel.querySelector<HTMLElement>("select:not(:disabled), button:not(:disabled)")?.focus();
      });
    }
  }
</script>

<svelte:window onkeydown={focusTools} />

{#snippet listButtons()}
  {#each structures as format (format.name)}
    <button
      class="reader-button"
      type="button"
      aria-label={format.label}
      title={format.label}
      disabled={!writingCommands[format.name](editorState)}
      onclick={() => action(writingCommands[format.name])}
    >
      <svg class="reader-icon" viewBox="0 0 24 24" aria-hidden="true"><path d={format.icon} /></svg
      ><span>{format.label}</span>
    </button>
  {/each}
{/snippet}
{#snippet historyButtons()}
  <button
    class="reader-button"
    type="button"
    disabled={!undo(editorState)}
    onclick={() => action(undo)}>撤销</button
  >
  <button
    class="reader-button"
    type="button"
    disabled={!redo(editorState)}
    onclick={() => action(redo)}>重做</button
  >
{/snippet}
<div
  {id}
  class="formatting-panel"
  class:docked={sidebar}
  role="toolbar"
  tabindex="-1"
  aria-label="编辑工具栏"
  aria-keyshortcuts="Alt+F10"
  bind:this={panel}
  onmousedown={(event) => {
    if (event.target instanceof HTMLElement && event.target.closest("button"))
      event.preventDefault();
  }}
>
  <select
    class="reader-input"
    aria-label="段落格式"
    value={block}
    onchange={(event) => setBlock(event.currentTarget.value)}
  >
    {#each blocks as option (option.name)}<option
        value={option.name}
        disabled={option.name !== block && !writingCommands[option.name](editorState)}
        >{option.label}</option
      >{/each}
  </select>
  {#if !minimal}<InlineFormatting state={editorState} onFormat={run} variant="primary" />{/if}
  {#if !compact}<div class="lists">{@render listButtons()}</div>{/if}
  <button
    class="reader-button"
    type="button"
    popovertarget="{id}-insert"
    aria-label="插入"
    title="插入链接、附件或表格">插入</button
  >
  {#if !compact}<div class="history">{@render historyButtons()}</div>{/if}
  <button
    class="reader-button"
    type="button"
    popovertarget="{id}-more"
    aria-label="更多编辑操作"
    title={table ? "表格与更多编辑操作" : "更多编辑操作"}>{table ? "表格" : "更多"}</button
  >
</div>
<div id="{id}-insert" bind:this={insertMenu} popover="auto" class="reader-popover formatting-menu">
  <button
    class="reader-button"
    type="button"
    disabled={!!editorState.selection.$from.parent.type.spec.code}
    onclick={() => {
      closeMenus();
      onLink();
    }}>链接…</button
  >
  <button
    class="reader-button"
    type="button"
    disabled={!canInsertAttachment(editorState)}
    aria-label="插入附件…"
    onclick={() => {
      closeMenus();
      onAttachment();
    }}>插入附件…</button
  >
  {#if onWebPage}<button
      class="reader-button"
      type="button"
      disabled={!canInsertWebPage(editorState)}
      aria-label="插入网页…"
      onclick={() => {
        closeMenus();
        onWebPage?.();
      }}>插入网页…</button
    >{/if}
  <button
    class="reader-button"
    type="button"
    disabled={!tableCommands.insert(editorState)}
    aria-label="插入表格"
    onclick={() => action(tableCommands.insert)}>插入表格</button
  >
</div>
<div id="{id}-more" bind:this={moreMenu} popover="auto" class="reader-popover formatting-menu">
  <InlineFormatting state={editorState} onFormat={action} variant={minimal ? "all" : "secondary"} />
  {#if compact}{@render listButtons()}{@render historyButtons()}{/if}
  {#if table}
    <hr />
    {#each tableStructure as item (item.name)}<button
        class="reader-button"
        type="button"
        disabled={!tableCommands[item.name](editorState)}
        onclick={() => action(tableCommands[item.name])}>{item.label}</button
      >{/each}
    {#each alignments as item (item.name)}<button
        class="reader-button"
        type="button"
        aria-pressed={editorState.selection.$from.parent.attrs["align"] === item.value}
        onclick={() => action(tableCommands[item.name])}>{item.label}</button
      >{/each}
    <button class="reader-button" type="button" onclick={() => action(leaveTable)}>返回正文</button>
    <button class="reader-button" type="button" onclick={() => action(tableCommands.remove)}
      >删除表格</button
    >
  {/if}
</div>

<style>
  .formatting-panel {
    display: flex;
    align-items: center;
    gap: 0.2rem;
    min-width: 0;
    padding: 0.35rem 0.5rem;
    border-bottom: 1px solid var(--border);
    background: var(--bg);
  }
  .formatting-panel.docked {
    flex-wrap: wrap;
    gap: 0.25rem;
    padding: 0.5rem 0.75rem;
    background: transparent;
  }
  select {
    width: 5.5rem;
    flex-shrink: 0;
  }
  .formatting-panel > button {
    flex-shrink: 0;
    font-size: 0.75rem;
    padding-inline: 0.4rem;
  }
  .lists,
  .history {
    display: flex;
  }
  .lists button {
    width: 2rem;
    padding: 0.25rem;
  }
  .lists span {
    display: none;
  }
  .history {
    margin-left: auto;
  }
  .history button {
    font-size: 0.75rem;
    padding: 0.3rem;
  }
  .formatting-menu {
    min-width: 12rem;
  }
  .formatting-menu > button {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    text-align: left;
  }
</style>
