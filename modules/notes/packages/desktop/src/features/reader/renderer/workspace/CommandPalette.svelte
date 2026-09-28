<script lang="ts">
  /**
   * 命令面板：列出当前可用的命令，模糊匹配中文名。
   *
   * 可用性与执行门禁共用 `commandAvailable`；空查询时本次运行用过的命令排在最前，
   * 使用记录不持久化。选择后先关闭弹层再执行，命令不会被自身的模态状态拦截。
   */
  import PickerDialog from "./PickerDialog.svelte";
  import {
    READER_COMMANDS,
    shortcutLabel,
    type CommandSpec,
    type ReaderCommand,
  } from "../../shared/commands";
  import { rankByFuzzy } from "../search/fuzzy";

  type Entry = CommandSpec & { id: ReaderCommand };

  let {
    available,
    recent,
    mac,
    onRun,
    onClose,
  }: {
    /** 命令当前是否可执行。 */
    available: (id: ReaderCommand) => boolean;
    /** 本次运行用过的命令，最新在前。 */
    recent: readonly ReaderCommand[];
    mac: boolean;
    /** 执行选中的命令；弹层已卸载。 */
    onRun: (id: ReaderCommand) => void;
    onClose: () => void;
  } = $props();

  let query = $state("");
  const commands = $derived(
    READER_COMMANDS.filter((command) => command.id !== "command-palette" && available(command.id)),
  );
  const ordered = $derived.by((): Entry[] => {
    const used = recent.flatMap((id) => commands.filter((command) => command.id === id));
    return [...used, ...commands.filter((command) => !recent.includes(command.id))];
  });
  const items = $derived(
    rankByFuzzy(query, ordered, (command) => [command.label, command.id], ordered.length),
  );
  const hints = [
    { keys: "↑↓", label: "选择" },
    { keys: "↵", label: "执行" },
    { keys: "Esc", label: "关闭" },
  ];

  function choose(command: Entry | null): void {
    if (command === null) return;
    onClose();
    onRun(command.id);
  }
</script>

<PickerDialog
  label="命令面板"
  placeholder="输入命令…"
  {items}
  itemKey={(command) => command.id}
  bind:query
  {hints}
  empty="没有匹配的命令"
  onChoose={(command) => choose(command)}
  onDismiss={onClose}
>
  {#snippet row(command: Entry)}
    <span class="label">{command.label}</span>
    {#if command.shortcut !== null}
      <kbd class="shortcut">{shortcutLabel(command.shortcut, mac)}</kbd>
    {/if}
  {/snippet}
</PickerDialog>

<style>
  .label {
    flex: 1 1 auto;
  }
  .shortcut {
    font: inherit;
    font-size: 0.78rem;
    color: var(--muted);
  }
</style>
