<script lang="ts">
  /** 顶栏常用命令平铺，分类菜单只承载同一类子操作；状态与执行均来自所属编辑器。 */
  import { tick } from "svelte";
  import { pointerIndicator } from "../../pointer-indicator";
  import type { Command, EditorState } from "prosemirror-state";
  import type { EditorView } from "prosemirror-view";
  import { undo, redo } from "prosemirror-history";
  import { writingCommands } from "../writing";
  import { readBlockFormatting } from "../block-formatting";
  import {
    canInsertTable,
    insertTable,
    inTable,
    leaveTable,
    tableCommands,
    type TableInsertOptions,
  } from "../table/table";
  import TableInsertPicker from "../table/TableInsertPicker.svelte";
  import { linkSelectionKey } from "../links/link-editing";
  import InlineFormatting from "./InlineFormatting.svelte";
  import FormattingMenu, { type FormattingMenuItem } from "./FormattingMenu.svelte";
  import { canInsertAttachment } from "../attachments/attachments";
  import { canInsertWebPage } from "../webpage/insert";

  let {
    id = "editor-formatting",
    view,
    state: editorState,
    onLink,
    onAttachment,
    onWebPage,
    onConversation,
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
    /** 在当前文章位置创建对话；能力由应用装配，独立编辑器可不提供。 */
    onConversation?: () => void;
    /** 快捷键进入工具前，让工作区完成必要的焦点与侧栏交接。 */
    onShowTools?: () => void;
  } = $props();

  const headings = [
    "heading1",
    "heading2",
    "heading3",
    "heading4",
    "heading5",
    "heading6",
  ] as const;
  const table = $derived(inTable(editorState));
  const structures = $derived(readBlockFormatting(editorState));
  const block = $derived(
    editorState.selection.$from.parent.type.name === "heading"
      ? `heading${String(editorState.selection.$from.parent.attrs["level"])}`
      : editorState.selection.$from.parent.type.name === "code_block"
        ? "codeBlock"
        : "paragraph",
  );
  const blockLabel = $derived(
    block === "codeBlock" ? "代码块" : block === "paragraph" ? "正文" : `标题 ${block.slice(-1)}`,
  );

  function item(
    id: string,
    label: string,
    command: Command,
    checked?: boolean,
  ): FormattingMenuItem {
    return {
      kind: "command",
      id,
      label,
      command,
      disabled: !command(editorState),
      ...(checked === undefined ? {} : { checked }),
    };
  }
  const blockItems = $derived<FormattingMenuItem[]>([
    item("paragraph", "正文", writingCommands.paragraph, block === "paragraph"),
    {
      kind: "submenu",
      id: "headings",
      label: "标题",
      items: headings.map((name, index) =>
        item(name, `标题 ${index + 1}`, writingCommands[name], block === name),
      ),
    },
    item("code", "代码块", writingCommands.codeBlock, block === "codeBlock"),
  ]);
  const listItems = $derived<FormattingMenuItem[]>([
    item("bullet", "项目列表", writingCommands.bulletList, structures.list === "bullet"),
    item("ordered", "编号列表", writingCommands.orderedList, structures.list === "ordered"),
    item("task", "任务列表", writingCommands.taskList, structures.list === "task"),
  ]);
  const tableItems = $derived<FormattingMenuItem[]>([
    {
      kind: "submenu",
      id: "rows",
      label: "行",
      disabled: !table,
      items: [
        item("add", "下方插入行", tableCommands.addRow),
        item("up", "上移当前行", tableCommands.moveRowUp),
        item("down", "下移当前行", tableCommands.moveRowDown),
        item("delete", "删除当前行", tableCommands.deleteRow),
      ],
    },
    {
      kind: "submenu",
      id: "columns",
      label: "列",
      disabled: !table,
      items: [
        item("add", "右侧插入列", tableCommands.addColumn),
        item("left", "左移当前列", tableCommands.moveColumnLeft),
        item("right", "右移当前列", tableCommands.moveColumnRight),
        item("delete", "删除当前列", tableCommands.deleteColumn),
      ],
    },
    {
      kind: "submenu",
      id: "alignment",
      label: "列对齐",
      disabled: !table,
      items: [
        item(
          "left",
          "列左对齐",
          tableCommands.alignLeft,
          editorState.selection.$from.parent.attrs["align"] === "left",
        ),
        item(
          "center",
          "列居中对齐",
          tableCommands.alignCenter,
          editorState.selection.$from.parent.attrs["align"] === "center",
        ),
        item(
          "right",
          "列右对齐",
          tableCommands.alignRight,
          editorState.selection.$from.parent.attrs["align"] === "right",
        ),
      ],
    },
    item("leave", "返回正文", leaveTable),
    item("remove", "删除表格", tableCommands.remove),
  ]);

  const insertItems = $derived.by((): FormattingMenuItem[] => {
    const entries: FormattingMenuItem[] = [
      {
        kind: "action",
        id: "link",
        label: "链接…",
        action: onLink,
        disabled: !!editorState.selection.$from.parent.type.spec.code,
      },
      {
        kind: "action",
        id: "attachment",
        label: "插入附件…",
        action: onAttachment,
        disabled: !canInsertAttachment(editorState),
      },
    ];
    if (onWebPage)
      entries.push({
        kind: "action",
        id: "webpage",
        label: "插入网页…",
        action: onWebPage,
        disabled: !canInsertWebPage(editorState),
      });
    entries.push({
      kind: "action",
      id: "table",
      label: "表格…",
      action: openTable,
      disabled: !canInsertTable(editorState),
    });
    if (onConversation)
      entries.push({
        kind: "action",
        id: "conversation",
        label: "插入 Agent 对话…",
        action: onConversation,
        disabled: !canInsertAttachment(editorState),
      });
    return entries;
  });

  function run(command: Command): void {
    if (view.isDestroyed || view.composing) return;
    command(view.state, view.dispatch, view);
    view.focus();
  }
  let panel: HTMLDivElement;
  let tablePicker: TableInsertPicker | undefined = $state();
  let tableOwner: EditorView | null = null;
  function openTable(): void {
    const source = panel.querySelector<HTMLButtonElement>('button[aria-label="插入"]');
    if (!source || !tablePicker || view.isDestroyed || view.composing || !canInsertTable(view.state))
      return;
    tableOwner = view;
    view.dispatch(view.state.tr.setMeta(linkSelectionKey, true).setMeta("addToHistory", false));
    tablePicker.open(source);
  }
  function closeTable(restoreFocus: boolean): void {
    const owner = tableOwner;
    tableOwner = null;
    if (!owner || owner.isDestroyed) return;
    owner.dispatch(owner.state.tr.setMeta(linkSelectionKey, false).setMeta("addToHistory", false));
    if (restoreFocus && owner === view) owner.focus();
  }
  function insertChosenTable(options: TableInsertOptions): void {
    const owner = tableOwner;
    if (!owner || owner !== view || owner.isDestroyed)
      throw new Error("原文档已更新，请关闭后重新选择插入位置");
    if (owner.composing) throw new Error("请完成正文输入后再插入表格");
    const bookmark = linkSelectionKey.getState(owner.state);
    if (!bookmark) throw new Error("原插入位置已失效，请重新选择正文位置");
    owner.dispatch(owner.state.tr.setSelection(bookmark.resolve(owner.state.doc)));
    if (!insertTable(options)(owner.state, owner.dispatch, owner))
      throw new Error("请在可编辑的同一段正文中选择插入位置");
  }
  $effect(() => {
    const owner = view;
    return () => {
      if (tableOwner === owner) tablePicker?.close(false);
    };
  });
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
        if (panel.isConnected)
          panel.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
      });
    }
  }
</script>

<svelte:window onkeydown={focusTools} />

<div
  {id}
  class="formatting-panel"
  role="toolbar"
  tabindex="-1"
  aria-label="编辑工具栏"
  aria-keyshortcuts="Alt+F10"
  bind:this={panel}
  use:pointerIndicator
  onmousedown={(event) => {
    // SVG 图标也属于按钮；阻止浏览器先清掉正文选区，再派发格式命令。
    if (event.target instanceof Element && event.target.closest("button")) event.preventDefault();
  }}
>
  <FormattingMenu
    id="{id}-blocks"
    label="段落格式"
    text={blockLabel}
    items={blockItems}
    onCommand={run}
  />
  <InlineFormatting {id} state={editorState} onFormat={run} />
  <span class="divider" aria-hidden="true"></span>
  <FormattingMenu
    id="{id}-lists"
    label="列表"
    icon={structures.list === "ordered"
      ? "M10 6h10M10 12h10M10 18h10M3 4h1v5M3 9h3M3 14c3-2 4 1 1 3l-1 2h3"
      : structures.list === "task"
        ? "m3 6 2 2 3-4M11 6h9M11 16h9M3 13h5v5H3z"
        : "M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"}
    pressed={structures.list === "mixed" ? "mixed" : structures.list !== null}
    items={listItems}
    onCommand={run}
  />
  <button
    class="reader-button tool"
    type="button"
    aria-label="引用"
    aria-pressed={structures.quote}
    title="引用"
    disabled={!writingCommands.quote(editorState)}
    onclick={() => run(writingCommands.quote)}
  >
    <svg class="reader-icon" viewBox="0 0 24 24" aria-hidden="true"
      ><path d="M3 21c3 0 7-1 7-8V5H2v8h8M14 21c3 0 7-1 7-8V5h-8v8h8" /></svg
    >
  </button>
  <span class="divider" aria-hidden="true"></span>
  {#if table}<FormattingMenu
      id="{id}-table"
      label="表格操作"
      text="表格"
      items={tableItems}
      onCommand={run}
    />{/if}
  <FormattingMenu id="{id}-insert" label="插入" text="插入" items={insertItems} onCommand={run} />
  <TableInsertPicker
    id="{id}-table-insert"
    bind:this={tablePicker}
    onInsert={insertChosenTable}
    onClose={closeTable}
  />
  <span class="divider" aria-hidden="true"></span>
  <button
    class="reader-button tool"
    type="button"
    aria-label="撤销"
    title="撤销（⌘/Ctrl+Z）"
    disabled={!undo(editorState)}
    onclick={() => run(undo)}
  >
    <svg class="reader-icon" viewBox="0 0 24 24" aria-hidden="true"
      ><path d="m7 4-4 4 4 4M3 8h10a6 6 0 0 1 0 12h-3" /></svg
    >
  </button>
  <button
    class="reader-button tool"
    type="button"
    aria-label="重做"
    title="重做（⌘/Ctrl+Shift+Z）"
    disabled={!redo(editorState)}
    onclick={() => run(redo)}
  >
    <svg class="reader-icon" viewBox="0 0 24 24" aria-hidden="true"
      ><path d="m17 4 4 4-4 4M21 8H11a6 6 0 0 0 0 12h3" /></svg
    >
  </button>
</div>

<style>
  .formatting-panel {
    display: flex;
    align-items: center;
    gap: 2px;
    width: max-content;
    min-width: max-content;
    padding: 4px 6px;
    border-bottom: 1px solid var(--border);
    background: var(--bg);
  }
  .tool {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 30px;
    min-width: 30px;
    min-height: 30px;
    height: 30px;
    padding: 0;
  }
  .tool .reader-icon {
    width: 17px;
    height: 17px;
  }
  .tool[aria-pressed="mixed"]::after {
    content: "";
    position: absolute;
    bottom: 2px;
    left: calc(50% - 3px);
    width: 6px;
    height: 2px;
    border-radius: 1px;
    background: var(--accent);
  }
  .divider {
    flex: 0 0 1px;
    height: 16px;
    margin: 0 4px;
    background: var(--border);
  }
</style>
