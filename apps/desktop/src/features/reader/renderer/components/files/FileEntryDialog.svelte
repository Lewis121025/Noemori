<script module lang="ts">
  /** 文件操作共用一个对话框；所有写入通过工作区的保存门禁。 */
  export type EntryDialogAction = "file" | "directory" | "rename" | "move" | "trash";
</script>

<script lang="ts">
  import { tick } from "svelte";
  import type { VaultEntry } from "../../../shared/api";
  import type { ReaderWorkspaceController } from "../../state/workspace.svelte";
  import { createCompositionGuard } from "../../engine/editing/composition";
  import { moveDestinations } from "../../engine/navigation/move-destinations";
  import MoveDestinationPicker from "./MoveDestinationPicker.svelte";
  import {
    entryNameError,
    parentDirectory,
    suggestEntryName,
    type FileEntryChange,
  } from "../../engine/navigation/file-tree";

  let {
    workspace,
    onComplete,
  }: {
    workspace: ReaderWorkspaceController;
    /** 操作提交后，由工作区统一更新目录上下文并交接输入焦点。 */
    onComplete: (change: FileEntryChange) => void;
  } = $props();
  let dialog: HTMLDialogElement;
  let input: HTMLInputElement | undefined = $state();
  let action = $state<EntryDialogAction>("file");
  let entry = $state<VaultEntry | null>(null);
  let name = $state("");
  let parent = $state("");
  let error = $state("");
  let busy = $state(false);
  let opening = $state(0);
  let moveParent = $state<string | null>(null);
  const composition = createCompositionGuard();
  const filename = $derived(
    action === "file" && !name.toLowerCase().endsWith(".md") ? `${name}.md` : name,
  );
  const directory = $derived(
    action === "move"
      ? (moveParent ?? parent)
      : action === "rename" && entry !== null
        ? parentDirectory(entry.path)
        : parent,
  );
  const destination = $derived(directory === "" ? filename : `${directory}/${filename}`);
  const unchanged = $derived(
    (action === "rename" || action === "move") && destination === entry?.path,
  );
  const unavailable = $derived(action === "move" && moveParent === null);
  const validation = $derived.by(() => {
    if (action === "trash") return null;
    if (action !== "move") {
      const invalid = entryNameError(name);
      if (invalid !== null) return invalid;
    }
    if (!unchanged && workspace.entries.some((item) => item.path === destination))
      return "此位置已有同名条目，请换一个名称或文件夹。";
    return null;
  });
  const issue = $derived(validation ?? error);
  const title = $derived(
    action === "file"
      ? "新建笔记"
      : action === "directory"
        ? "新建文件夹"
        : action === "rename"
          ? "重命名"
          : action === "move"
            ? "移动到文件夹"
            : "移到废纸篓",
  );
  const confirmLabel = $derived(
    action === "file" || action === "directory" ? "创建" : action === "move" ? "移动" : title,
  );
  const destinations = $derived(entry === null ? [] : moveDestinations(workspace.entries, entry));

  /** 打开条目操作；目标为库内条目，新建时 parentPath 决定所在文件夹。 */
  export async function open(
    next: typeof action,
    target: VaultEntry | null,
    parentPath: string,
  ): Promise<void> {
    action = next;
    entry = target;
    parent = parentPath;
    moveParent = null;
    opening += 1;
    error = "";
    name =
      next === "file" || next === "directory"
        ? suggestEntryName(workspace.entries, parentPath, next)
        : (target?.path.split("/").at(-1) ?? "");
    dialog.showModal();
    await tick();
    if (next !== "move" && next !== "trash") {
      input?.focus();
      const dot = name.lastIndexOf(".");
      input?.setSelectionRange(
        0,
        (next === "file" || target?.kind === "file") && dot > 0 ? dot : name.length,
      );
    }
  }

  async function submit(): Promise<void> {
    if (composition.active || busy || unchanged || unavailable || validation !== null) return;
    // 提交后目录刷新会改变候选有效性；完成事件必须描述实际提交的路径。
    const requested = { action, entry, destination };
    busy = true;
    error = "";
    try {
      let result: string | null;
      if (requested.action === "trash")
        result =
          requested.entry === null
            ? "没有选中的条目"
            : await workspace.trashEntry(requested.entry.path);
      else {
        result =
          requested.action === "file" || requested.action === "directory"
            ? await workspace.createEntry(requested.destination, requested.action)
            : requested.entry === null
              ? "没有选中的条目"
              : await workspace.renameEntry(requested.entry.path, requested.destination);
      }
      if (result === null) {
        dialog.close();
        if (requested.action === "file" || requested.action === "directory")
          onComplete({
            action: "create",
            entry: { path: requested.destination, kind: requested.action },
          });
        else if (requested.entry !== null)
          onComplete(
            requested.action === "trash"
              ? { action: "trash", entry: requested.entry }
              : {
                  action: "relocate",
                  from: requested.entry.path,
                  entry: { ...requested.entry, path: requested.destination },
                },
          );
      } else error = result;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }
</script>

<dialog
  class="entry-dialog"
  bind:this={dialog}
  use:composition.bind
  aria-labelledby="entry-dialog-title"
  oncancel={(event) => {
    if (busy || composition.active) event.preventDefault();
  }}
>
  <form
    onsubmit={(event) => {
      event.preventDefault();
      void submit();
    }}
  >
    <h2 id="entry-dialog-title">{title}</h2>
    {#if action === "trash"}
      <p>
        将“{name}”移到系统废纸篓？{entry?.kind === "directory" ? "其中的所有文件会一起移动。" : ""}
      </p>
      <p class="hint">可以从系统废纸篓恢复。</p>
    {:else if action === "move"}
      <p class="hint">{entry?.path}</p>
      {#key opening}
        <MoveDestinationPicker
          {destinations}
          initialPath={parent}
          disabled={busy}
          onSelect={(path) => {
            moveParent = path;
            error = "";
          }}
        />
      {/key}
      {#if moveParent !== null}<p class="hint">移动后：{destination}</p>{/if}
    {:else}
      <label for="entry-name"
        >{action === "directory" || entry?.kind === "directory" ? "文件夹名称" : "文件名"}</label
      >
      <input
        id="entry-name"
        class="reader-input"
        bind:this={input}
        bind:value={name}
        disabled={busy}
        autocomplete="off"
        spellcheck="false"
        aria-invalid={!!issue}
        aria-describedby={issue ? "entry-location entry-error" : "entry-location"}
        oninput={() => {
          error = "";
        }}
      />
      <p class="hint" id="entry-location">位置：{parent || "笔记库根目录"}</p>
    {/if}
    {#if issue}<p class="error" id="entry-error" role="alert">{issue}</p>{/if}
    <div class="actions">
      <button
        class="reader-button"
        type="button"
        disabled={busy}
        onclick={() => {
          if (!composition.active) dialog.close();
        }}>取消</button
      >
      <button
        class="reader-button primary"
        class:destructive={action === "trash"}
        type="submit"
        disabled={busy || unchanged || unavailable || validation !== null}
        >{busy ? "处理中…" : confirmLabel}</button
      >
    </div>
  </form>
</dialog>

<style>
  .entry-dialog {
    width: min(26rem, calc(100vw - 2rem));
    padding: 1.5rem;
    color: var(--fg);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 1rem;
    box-shadow:
      0 8px 24px var(--shadow),
      0 24px 80px var(--shadow);
  }
  .entry-dialog::backdrop {
    background: var(--scrim);
    backdrop-filter: blur(3px);
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
  }
  h2 {
    font-size: 1.15rem;
    font-weight: 600;
    margin: 0 0 0.65rem;
  }
  p {
    margin: 0;
    overflow-wrap: anywhere;
  }
  label,
  .hint {
    font-size: 0.85rem;
    color: var(--muted);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 1rem;
  }
  .actions button {
    min-width: 5rem;
  }
  .error {
    color: var(--danger);
    font-size: 0.85rem;
  }
  button.destructive {
    background: var(--danger);
    color: var(--bg);
  }
</style>
