<script lang="ts">
  /** 编辑模式常驻工具栏；所有命令直接使用所属编辑器选区，不复制文档状态。 */
  import type { Command, EditorState } from "prosemirror-state";
  import type { EditorView } from "prosemirror-view";
  import { undo, redo } from "prosemirror-history";
  import { writingCommands } from "../writing";
  import { inTable, leaveTable, tableCommands } from "../table/table";
  import InlineFormatting from "./InlineFormatting.svelte";
  import { canInsertAttachment } from "../attachments/attachments";

  let {
    id = "editor-formatting",
    view,
    state: editorState,
    onLink,
    onAttachment,
  }: {
    /** 工具栏 DOM id；各分栏身份独立，操作始终作用于所属编辑器。 */
    id?: string;
    view: EditorView;
    state: EditorState;
    onLink: () => void;
    onAttachment: () => void;
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
</script>

<div
  {id}
  class="formatting-panel"
  role="toolbar"
  aria-label="编辑工具栏"
  tabindex="-1"
  onmousedown={(event) => {
    if (event.target instanceof HTMLElement && event.target.closest("button"))
      event.preventDefault();
  }}
>
  {#if !table}
    <select
      class="reader-input"
      aria-label="段落格式"
      value={block}
      onchange={(event) => setBlock(event.currentTarget.value)}
    >
      {#each blocks as option (option.name)}
        <option
          value={option.name}
          disabled={option.name !== block && !writingCommands[option.name](editorState)}
          >{option.label}</option
        >
      {/each}
    </select>
  {/if}
  <div class="inline-controls">
    <InlineFormatting state={editorState} onFormat={run} />
  </div>
  <div class="structures">
    {#if table}
      <div class="table-structure">
        {#each tableStructure as action (action.name)}
          <button
            class="reader-button"
            type="button"
            disabled={!tableCommands[action.name](editorState)}
            onclick={() => run(tableCommands[action.name])}>{action.label}</button
          >
        {/each}
      </div>
      <div class="column-alignment" role="group" aria-label="列对齐">
        {#each alignments as alignment (alignment.name)}
          <button
            class="reader-button"
            type="button"
            aria-label={alignment.label}
            title={alignment.label}
            aria-pressed={editorState.selection.$from.parent.attrs["align"] === alignment.value}
            onclick={() => run(tableCommands[alignment.name])}
          >
            <svg class="reader-icon" viewBox="0 0 24 24" aria-hidden="true"
              ><path d={alignment.icon} /></svg
            >
          </button>
        {/each}
      </div>
      <div class="table-structure">
        <button class="reader-button" type="button" onclick={() => run(leaveTable)}>返回正文</button
        >
        <button class="reader-button" type="button" onclick={() => run(tableCommands.remove)}
          >删除表格</button
        >
      </div>
    {:else}
      {#each structures as format (format.name)}
        <button
          class="reader-button action"
          type="button"
          aria-label={format.label}
          title={format.label}
          disabled={!writingCommands[format.name](editorState)}
          onclick={() => run(writingCommands[format.name])}
        >
          <svg class="reader-icon" viewBox="0 0 24 24" aria-hidden="true"
            ><path d={format.icon} /></svg
          ><span class="action-label">{format.label}</span>
        </button>
      {/each}
      <button
        class="reader-button action"
        type="button"
        aria-label="插入表格"
        title="插入表格"
        disabled={!tableCommands.insert(editorState)}
        onclick={() => run(tableCommands.insert)}
      >
        <svg class="reader-icon" viewBox="0 0 24 24" aria-hidden="true"
          ><path d="M4 4h16v16H4zM4 10h16M10 4v16" /></svg
        >
        插入表格
      </button>
    {/if}
    <button
      class="reader-button action"
      type="button"
      aria-label="链接…"
      title="链接"
      disabled={!!editorState.selection.$from.parent.type.spec.code}
      onclick={() => {
        onLink();
      }}
    >
      <svg class="reader-icon" viewBox="0 0 24 24" aria-hidden="true"
        ><path
          d="m10 13 4-4M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M13 8l1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0"
        /></svg
      >链接…
    </button>
    <button
      class="reader-button action"
      type="button"
      aria-label="插入附件…"
      title="插入附件"
      disabled={!canInsertAttachment(editorState)}
      onclick={() => {
        onAttachment();
      }}
    >
      <svg class="reader-icon" viewBox="0 0 24 24" aria-hidden="true"
        ><path d="m8 12 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l8-8M7 13l6-6" /></svg
      >
      插入附件…
    </button>
  </div>
  <div class="history">
    <button
      class="reader-button"
      type="button"
      disabled={!undo(editorState)}
      onclick={() => run(undo)}>撤销</button
    >
    <button
      class="reader-button"
      type="button"
      disabled={!redo(editorState)}
      onclick={() => run(redo)}>重做</button
    >
  </div>
</div>

<style>
  .formatting-panel {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.3rem;
    padding: 0.55rem;
    margin: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-control, 0.5rem);
    background: var(--bg);
    box-shadow: 0 2px 8px var(--shadow);
  }
  select {
    width: 6.5rem;
  }
  .inline-controls,
  .structures,
  .history,
  .column-alignment,
  .table-structure {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.2rem;
  }
  .structures {
    display: contents;
  }
  .inline-controls {
    min-width: 0;
    max-width: 100%;
  }
  .inline-controls :global(.marks) {
    min-width: 0;
    flex-wrap: wrap;
  }
  .inline-controls :global(.marks > button) {
    flex: 0 0 2rem;
  }
  .action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    padding: 0.3rem;
    font-size: 0;
  }
  .action-label {
    display: none;
  }
  .reader-button {
    border-color: transparent;
    background: transparent;
  }
  .history {
    margin-left: auto;
  }
  .history button,
  .table-structure button {
    font-size: 0.75rem;
    padding: 0.35rem;
  }
  .column-alignment button {
    display: flex;
    padding: 0.35rem;
  }
</style>
