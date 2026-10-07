<script lang="ts">
  import { tick } from "svelte";
  import type { VaultEntry } from "../../shared/api";
  import {
    independentEntryPaths,
    planEntryBatch,
    type EntryBatchRequest,
    type EntryBatchProgress,
    type EntryBatchResult,
  } from "../../shared/entry-batch";
  import type { ReaderWorkspaceController } from "../workspace/state.svelte";
  import { createCompositionGuard } from "../../shared/composition";
  import { moveDestinations } from "./move-destinations";
  import { parentDirectory } from "./file-tree";
  import MoveDestinationPicker from "./MoveDestinationPicker.svelte";

  let {
    workspace,
    onComplete,
    onClose,
  }: {
    workspace: ReaderWorkspaceController;
    onComplete: (result: EntryBatchResult) => Promise<void>;
    onClose: () => void;
  } = $props();
  let dialog: HTMLDialogElement;
  let action = $state<"move" | "trash">("move");
  let root = $state("");
  let sources = $state.raw<VaultEntry[]>([]);
  let remaining = $state<string[]>([]);
  let destination = $state<string | null>(null);
  let opening = $state(0);
  let busy = $state(false);
  let progress = $state.raw<EntryBatchProgress | null>(null);
  let stopping = $state(false);
  let stopFailure = $state("");
  let result = $state.raw<EntryBatchResult | null>(null);
  let completed = $state(0);
  let skipped = $state(0);
  let failure = $state("");
  let warning = $state("");
  const composition = createCompositionGuard();
  const id = $props.id();
  const stopped = $derived(
    result !== null && result.remaining.length > 0 && result.issues.length === 0,
  );
  const pendingPaths = $derived(new Set(remaining));
  const pendingSources = $derived(sources.filter((entry) => pendingPaths.has(entry.path)));
  const destinations = $derived(moveDestinations(workspace.entries, pendingSources));
  const request = $derived<EntryBatchRequest | null>(
    action === "trash"
      ? { root, action, paths: remaining }
      : destination === null
        ? null
        : { root, action, paths: remaining, destination },
  );
  const plan = $derived(request === null ? null : planEntryBatch(workspace.entries, request));
  const ready = $derived(
    !busy &&
      failure === "" &&
      request !== null &&
      remaining.length > 0 &&
      plan?.issues.length === 0,
  );

  /** 打开批量确认；输入为实际选中条目，父子去重只改变执行范围，不丢失说明。 */
  export async function open(next: "move" | "trash", entries: VaultEntry[]): Promise<void> {
    prepare(next, entries);
    dialog.showModal();
    await tick();
    if (next === "trash") dialog.querySelector<HTMLButtonElement>('button[type="button"]')?.focus();
  }

  function prepare(next: "move" | "trash", entries: VaultEntry[]): void {
    action = next;
    root = workspace.vaultRoot ?? "";
    const paths = new Set(independentEntryPaths(entries.map((entry) => entry.path)));
    sources = entries.filter((entry) => paths.has(entry.path));
    remaining = [...paths];
    destination = null;
    result = null;
    completed = 0;
    skipped = 0;
    failure = "";
    warning = "";
    progress = null;
    stopping = false;
    stopFailure = "";
    opening += 1;
  }

  /** 拖拽已指定目标时直接执行；耗时批次显示进度，短操作成功后保持目录现场。 */
  export async function drop(entries: VaultEntry[], target: string): Promise<void> {
    prepare("move", entries);
    destination = target;
    await submit(true);
  }

  async function submit(dragged = false): Promise<void> {
    if (busy || failure !== "" || composition.active || request === null || remaining.length === 0)
      return;
    const submitted = { ...request, paths: [...remaining] };
    busy = true;
    progress = null;
    stopping = false;
    stopFailure = "";
    const reveal = dragged
      ? setTimeout(() => {
          if (busy && !dialog.open) dialog.showModal();
        }, 200)
      : undefined;
    try {
      const outcome = await workspace.batchEntries(submitted, (next) => {
        progress = next;
      });
      result = outcome;
      warning = [warning, outcome.warning].filter(Boolean).join("；");
      completed += outcome.completed.length;
      skipped += outcome.skipped.length;
      remaining = outcome.remaining;
      await onComplete(outcome);
      if (remaining.length === 0 && outcome.issues.length === 0 && warning === "") {
        workspace.announce(
          completed === 0 && skipped > 0
            ? "所选条目已在目标位置，无需移动。"
            : `已${action === "move" ? "移动" : "移到废纸篓"} ${completed} 个条目${skipped > 0 ? `，${skipped} 个已在目标位置` : ""}。`,
        );
        if (dialog.open) dialog.close();
        else onClose();
      } else if (dragged && !dialog.open) {
        dialog.showModal();
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      if (!dialog.open) dialog.showModal();
    } finally {
      clearTimeout(reveal);
      busy = false;
      if (dragged && dialog.open) {
        await tick();
        const control =
          dialog.querySelector<HTMLElement>('[role="combobox"]') ??
          dialog.querySelector<HTMLButtonElement>('button[type="button"]');
        control?.focus();
      }
    }
  }

  async function stop(): Promise<void> {
    if (!busy || stopping || progress === null || composition.active) return;
    stopping = true;
    try {
      await workspace.stopBatchEntries(root);
    } catch (error) {
      stopping = false;
      stopFailure = `停止请求未送达：${error instanceof Error ? error.message : String(error)}`;
    }
  }
</script>

<dialog
  class="batch-dialog"
  bind:this={dialog}
  aria-labelledby={id}
  use:composition.bind
  oncancel={(event) => {
    if (busy || composition.active) event.preventDefault();
  }}
  onclose={onClose}
>
  <form
    onsubmit={(event) => {
      event.preventDefault();
      void submit();
    }}
  >
    <h2 {id}>{action === "move" ? "批量移动" : "批量移到废纸篓"}</h2>
    {#if busy}
      <div class="batch-progress" role="status">
        <p>
          {stopping
            ? "正在停止，等待当前条目完成…"
            : progress?.phase === "running"
              ? `本次已完成 ${progress.completed} / ${progress.total} 项`
              : progress === null
                ? "正在保存当前编辑…"
                : "正在检查所有条目…"}
        </p>
        {#if progress?.phase === "running" && progress.total > 0}
          <progress aria-label="批量操作进度" value={progress.completed} max={progress.total}
          ></progress>
        {:else}<progress aria-label="批量操作进度"></progress>{/if}
      </div>
    {:else if stopped}
      <p role="status">已停止；已完成的条目会保留，继续时只处理剩余项。</p>
    {/if}
    {#if completed > 0 || skipped > 0}
      <p role="status">
        已完成 {completed} 项{skipped > 0 ? `，${skipped} 项已在目标位置` : ""}，剩余 {remaining.length}
        项。
      </p>
    {:else}<p>
        将{action === "move" ? "移动" : "移到废纸篓"}
        {sources.length} 项。文件夹中的内容会一起处理。
      </p>{/if}
    {#if remaining.length > 0}
      <ul class="sources" aria-label="待处理条目">
        {#each remaining.slice(0, 12) as path (path)}<li title={path}>{path}</li>{/each}
        {#if remaining.length > 12}<li class="hint">另有 {remaining.length - 12} 项</li>{/if}
      </ul>
      {#if action === "move"}
        {#key opening}
          <MoveDestinationPicker
            {destinations}
            initialPath={destination ?? parentDirectory(sources[0]?.path ?? "")}
            disabled={busy}
            onSelect={(path) => {
              destination = path;
            }}
          />
        {/key}
      {:else}<p class="hint">可从系统废纸篓恢复。操作前会先检查所有条目。</p>{/if}
    {/if}
    {#if failure !== ""}<p class="issues" role="alert">{failure}</p>{/if}
    {#if stopFailure !== ""}<p class="issues" role="alert">{stopFailure}</p>{/if}
    {#if result !== null && (result.issues.length > 0 || warning !== "")}
      <div class="issues" role="alert">
        {#if result.issues.length > 0}<p>
            {completed === 0
              ? "本次未完成任何条目。"
              : "已停止，已完成的条目会保留；重试只处理剩余项。"}
          </p>{/if}
        {#each result.issues.slice(0, 12) as issue (issue)}<p>
            {issue.path ? `${issue.path}：` : ""}{issue.message}
          </p>{/each}
        {#if warning}<p>{warning}</p>{/if}
      </div>
    {/if}
    {#if result === null && failure === "" && plan !== null && plan.issues.length > 0}
      <div class="issues" role="alert">
        {#each plan.issues.slice(0, 12) as issue (issue)}<p>{issue.path}：{issue.message}</p>{/each}
      </div>
    {/if}
    <div class="actions">
      {#if !busy}<button
          class="reader-button"
          type="button"
          onclick={() => {
            if (!composition.active) dialog.close();
          }}>{result === null && failure === "" ? "取消" : "关闭"}</button
        >{/if}
      {#if busy}
        <button
          class="reader-button"
          type="button"
          disabled={stopping || progress === null}
          onclick={() => void stop()}
        >
          {stopping ? "正在停止…" : "停止"}
        </button>
      {:else if remaining.length > 0 && failure === ""}<button
          class="reader-button primary"
          class:destructive={action === "trash"}
          type="submit"
          disabled={!ready}
          >{stopped
            ? "继续剩余项"
            : result !== null
              ? "重试剩余项"
              : action === "move"
                ? "移动"
                : "移到废纸篓"}</button
        >{/if}
    </div>
  </form>
</dialog>

<style>
  .batch-dialog {
    width: min(30rem, calc(100vw - 2rem));
    max-height: calc(100dvh - 2rem);
    overflow: auto;
    padding: 1.4rem;
    color: var(--fg);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 1rem;
    box-shadow: 0 16px 60px var(--shadow);
  }
  .batch-dialog::backdrop {
    background: var(--scrim);
    backdrop-filter: blur(3px);
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
  }
  h2 {
    font-size: 1.1rem;
    font-weight: 600;
    margin: 0 0 0.3rem;
  }
  p {
    margin: 0;
    overflow-wrap: anywhere;
    font-size: 0.85rem;
  }
  .sources {
    max-height: 7rem;
    overflow: auto;
    margin: 0;
    padding-left: 1.2rem;
    font-size: 0.85rem;
  }
  .batch-progress {
    display: grid;
    gap: 0.5rem;
  }
  progress {
    width: 100%;
    accent-color: var(--accent);
  }
  li {
    overflow-wrap: anywhere;
    padding: 0.1rem 0;
  }
  .hint {
    color: var(--muted);
  }
  .issues {
    display: grid;
    gap: 0.4rem;
    color: var(--danger);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.4rem;
  }
  .destructive {
    background: var(--danger);
    color: var(--bg);
  }
</style>
