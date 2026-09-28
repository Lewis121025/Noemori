<script lang="ts">
  /**
   * 快速切换器：按文件名、路径、标题与别名打开文件，空查询列出最近打开。
   *
   * Enter 在活动栏打开；Cmd/Ctrl+Enter 在另一栏打开（单栏时先拆栏）；
   * Shift+Enter 或无命中时 Enter 按输入新建笔记，创建失败时保留弹层显示原因。
   */
  import { onMount } from "svelte";
  import PickerDialog from "../workspace/PickerDialog.svelte";
  import type { NoteKeys } from "../../shared/api";
  import type { ReaderWorkspaceController } from "../workspace/state.svelte";
  import { createNotePath, rankSwitcher, switcherEntries, type SwitcherHit } from "./switcher";

  let {
    workspace,
    mac,
    onClose,
    onOpened,
    onCreated,
  }: {
    workspace: ReaderWorkspaceController;
    /** 按键提示是否使用 macOS 符号。 */
    mac: boolean;
    /** 卸载弹层；由工作区清除打开状态。 */
    onClose: () => void;
    /** 已在某栏打开文件，工作区负责交接焦点。 */
    onOpened: () => void;
    /** 新笔记已创建并打开，工作区负责同步文件栏。 */
    onCreated: (path: string) => void;
  } = $props();

  let query = $state("");
  let keys = $state<NoteKeys[]>([]);
  let notice = $state("");
  let busy = $state(false);
  const entries = $derived(switcherEntries(workspace.files, keys));
  const hits = $derived(rankSwitcher(query, entries, workspace.recentFiles));
  const mod = $derived(mac ? "⌘" : "Ctrl+");
  const hints = $derived([
    { keys: "↑↓", label: "选择" },
    { keys: "↵", label: "打开" },
    { keys: `${mod}↵`, label: "在另一栏打开" },
    { keys: mac ? "⇧↵" : "Shift+↵", label: "新建笔记" },
    { keys: "Esc", label: "关闭" },
  ]);

  onMount(() => {
    void workspace.listNoteKeys().then((result) => {
      keys = result.keys;
      if (result.error !== null) notice = result.error;
    });
  });

  async function choose(
    hit: SwitcherHit | null,
    modifiers: { mod: boolean; shift: boolean },
  ): Promise<void> {
    if (busy) return;
    if (hit === null || modifiers.shift) {
      await create();
      return;
    }
    onClose();
    if (modifiers.mod) await workspace.openInOtherPane(hit.entry.path);
    else await workspace.openFile(hit.entry.path);
    onOpened();
  }

  async function create(): Promise<void> {
    const path = createNotePath(query);
    if (path === null) return;
    busy = true;
    try {
      const error = await workspace.createEntry(path, "file");
      if (error !== null) {
        notice = error;
        return;
      }
      onClose();
      onCreated(path);
    } finally {
      busy = false;
    }
  }
</script>

<PickerDialog
  label="快速切换"
  placeholder="输入文件名、标题或别名…"
  items={hits}
  itemKey={(hit) => hit.entry.path}
  bind:query
  {hints}
  {notice}
  empty={query.trim() === ""
    ? "笔记库中还没有文件"
    : `没有匹配的文件，按 Enter 新建「${query.trim()}」`}
  onChoose={(hit, modifiers) => void choose(hit, modifiers)}
  onDismiss={onClose}
>
  {#snippet row(hit: SwitcherHit)}
    <span class="name">{hit.entry.label}</span>
    {#if hit.alias !== null}
      <span class="alias">别名：{hit.alias}</span>
    {:else if hit.entry.title !== null && hit.entry.title !== hit.entry.label}
      <span class="alias">{hit.entry.title}</span>
    {/if}
    {#if hit.entry.directory !== ""}<span class="path">{hit.entry.directory}</span>{/if}
  {/snippet}
</PickerDialog>

<style>
  .name {
    font-weight: 500;
    white-space: nowrap;
  }
  .alias,
  .path {
    font-size: 0.8rem;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .path {
    margin-left: auto;
  }
</style>
