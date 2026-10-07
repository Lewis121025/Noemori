<script lang="ts">
  /**
   * 快速切换器：按文件名、路径、标题与别名打开文件，空查询列出最近打开。
   *
   * Enter 在活动栏打开；Cmd/Ctrl+Enter 在另一栏打开（单栏时先拆栏）；
   * Shift+Enter 或选择新建候选后进入名称与位置确认；打开失败保留弹层。
   */
  import { onMount, tick } from "svelte";
  import PickerDialog from "../workspace/PickerDialog.svelte";
  import type { NoteKeys } from "../../shared/api";
  import type { ReaderWorkspaceController } from "../workspace/state.svelte";
  import { createNotePath, rankSwitcher, switcherEntries, type SwitcherHit } from "./switcher";

  let {
    workspace,
    mac,
    onClose,
    onOpened,
    onCreate,
    otherPane = false,
  }: {
    otherPane?: boolean;
    workspace: ReaderWorkspaceController;
    /** 按键提示是否使用 macOS 符号。 */
    mac: boolean;
    /** 卸载弹层；由工作区清除打开状态。 */
    onClose: () => void;
    /** 已在某栏打开文件，工作区负责交接焦点。 */
    onOpened: () => void;
    /** 交付用户输入的建议路径，工作区统一确认名称和保存位置。 */
    onCreate: (path: string) => void;
  } = $props();

  let query = $state("");
  let keys = $state<NoteKeys[]>([]);
  let notice = $state("");
  let busy = $state(false);
  const entries = $derived(switcherEntries(workspace.files, keys));
  const hits = $derived(rankSwitcher(query, entries, workspace.recentFiles));
  type Candidate = { kind: "file"; hit: SwitcherHit } | { kind: "create"; path: string };
  const candidates = $derived.by((): Candidate[] => {
    const result: Candidate[] = hits.map((hit) => ({ kind: "file", hit }));
    const path = createNotePath(query);
    if (!otherPane && path !== null && !workspace.files.includes(path))
      result.push({ kind: "create", path });
    return result;
  });
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
    item: Candidate | null,
    modifiers: { mod: boolean; shift: boolean },
  ): Promise<void> {
    if (busy || item === null) return;
    if (item.kind === "create" || (modifiers.shift && !otherPane)) {
      await create();
      return;
    }
    busy = true;
    const path = item.hit.entry.path;
    try {
      const opened =
        otherPane || modifiers.mod
          ? await workspace.openInOtherPane(path)
          : await workspace.openFile(path).then(() => workspace.document.path === path);
      if (!opened) {
        notice = workspace.message || "未能打开文件，请重试。";
        return;
      }
      const pane = workspace.activePane.id;
      onClose();
      // 原生模态框关闭会恢复旧焦点；完成后再交接给用户指定的目标分栏。
      await tick();
      workspace.activatePane(pane);
      onOpened();
    } finally {
      busy = false;
    }
  }

  async function create(): Promise<void> {
    const path = createNotePath(query);
    if (path === null) return;
    onClose();
    await tick();
    onCreate(path);
  }
</script>

<PickerDialog
  label={otherPane ? "在另一栏打开" : "快速打开"}
  placeholder="输入文件名、标题或别名…"
  items={candidates}
  itemKey={(item) => (item.kind === "create" ? `create:${item.path}` : item.hit.entry.path)}
  bind:query
  {hints}
  {notice}
  empty={query.trim() === "" ? "笔记库中还没有文件" : "没有匹配的文件"}
  onChoose={(hit, modifiers) => void choose(hit, modifiers)}
  onDismiss={onClose}
>
  {#snippet row(item: Candidate)}
    {#if item.kind === "create"}<span class="name">＋ 新建笔记「{query.trim()}」</span>
    {:else}{@const hit = item.hit}
      <span class="name">{hit.entry.label}</span>
      {#if hit.alias !== null}
        <span class="alias">别名：{hit.alias}</span>
      {:else if hit.entry.title !== null && hit.entry.title !== hit.entry.label}
        <span class="alias">{hit.entry.title}</span>
      {/if}
      {#if hit.entry.directory !== ""}<span class="path">{hit.entry.directory}</span>{/if}
    {/if}
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
