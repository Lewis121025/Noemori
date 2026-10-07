<script module lang="ts">
  /** 创建类型决定文件后缀和初始内容；目标位置必须由用户确认。 */
  export type CreateEntryKind = "note" | "whiteboard" | "directory";
</script>

<script lang="ts">
  import { tick } from "svelte";
  import type { ReaderWorkspaceController } from "../workspace/state.svelte";
  import { createCompositionGuard } from "../../shared/composition";
  import { emptyWhiteboard, serializeWhiteboard } from "../../shared/whiteboard/model";
  import { entryNameError, suggestEntryName, type FileEntryChange } from "./file-tree";
  import { untitledNotePath, untitledWhiteboardPath } from "./library";
  import DirectoryPicker from "./DirectoryPicker.svelte";
  import type { MoveDestination } from "./move-destinations";

  let {
    workspace,
    onComplete,
  }: {
    workspace: ReaderWorkspaceController;
    /** 成功后携带实际创建路径，外壳据此更新浏览位置和文档焦点。 */
    onComplete: (change: FileEntryChange) => void;
  } = $props();
  let dialog: HTMLDialogElement;
  let input: HTMLInputElement;
  let kind = $state<CreateEntryKind>("note");
  let name = $state("");
  let initialDirectory = $state("");
  let directory = $state<string | null>(null);
  let root = $state<string | null>(null);
  let opening = $state(0);
  let busy = $state(false);
  let error = $state("");
  const composition = createCompositionGuard();
  const title = $derived(
    kind === "note" ? "新建笔记" : kind === "whiteboard" ? "新建白板" : "新建文件夹",
  );
  const extension = $derived(
    kind === "note" ? ".md" : kind === "whiteboard" ? ".noemoriboard" : "",
  );
  const filename = $derived(
    extension && !name.toLowerCase().endsWith(extension) ? `${name}${extension}` : name,
  );
  const destination = $derived(directory ? `${directory}/${filename}` : filename);
  const destinations = $derived<MoveDestination[]>([
    { path: "", reason: null },
    ...workspace.entries
      .filter((entry) => entry.kind === "directory" && !entry.recoveryOnly)
      .map((entry) => ({ path: entry.path, reason: null }))
      .sort((a, b) => a.path.localeCompare(b.path, "zh-CN", { numeric: true })),
  ]);
  const validation = $derived.by(() => {
    if (root === null || root !== workspace.vaultRoot) return "笔记库已改变，请重新发起创建。";
    const invalid = entryNameError(name);
    if (invalid) return invalid;
    if (directory === null || !destinations.some((item) => item.path === directory))
      return "请选择一个存在的文件夹。";
    if (
      workspace.entries.some(
        (entry) => entry.path.toLocaleLowerCase() === destination.toLocaleLowerCase(),
      )
    )
      return "此位置已有同名条目，请修改名称或选择其他文件夹。";
    return null;
  });

  /**
   * 展示创建意图，不创建文件；首次焦点落在名称，默认目录始终可见、可更改。
   * @param next 用户选择的笔记、白板或文件夹类型。
   * @param parent 当前浏览目录；空字符串表示库根。
   * @param suggestedName 快速打开传来的文件名建议；仍需用户确认。
   * @returns 名称已选中、表单可操作后兑现。
   * @throws 原生对话框无法显示或笔记库未打开时拒绝。
   */
  export async function open(
    next: CreateEntryKind,
    parent: string,
    suggestedName?: string,
  ): Promise<void> {
    if (workspace.vaultRoot === null) throw new Error("请先打开笔记库");
    kind = next;
    root = workspace.vaultRoot;
    initialDirectory = parent;
    directory = parent;
    error = "";
    opening += 1;
    const suggested =
      next === "note"
        ? untitledNotePath(workspace.entries, parent).split("/").at(-1)!
        : next === "whiteboard"
          ? untitledWhiteboardPath(workspace.entries, parent).split("/").at(-1)!
          : suggestEntryName(workspace.entries, parent, "directory");
    const suffix = next === "note" ? ".md" : next === "whiteboard" ? ".noemoriboard" : "";
    const initialName = suggestedName ?? suggested;
    name =
      suffix && initialName.toLowerCase().endsWith(suffix)
        ? initialName.slice(0, -suffix.length)
        : initialName;
    dialog.showModal();
    await tick();
    input.focus();
    input.select();
  }

  async function submit(): Promise<void> {
    if (
      busy ||
      composition.active ||
      workspace.switching ||
      workspace.copying ||
      validation !== null
    )
      return;
    const requested = { kind, destination };
    busy = true;
    error = "";
    try {
      const type = requested.kind === "directory" ? "directory" : "file";
      const initial =
        requested.kind === "whiteboard"
          ? new TextEncoder().encode(serializeWhiteboard(emptyWhiteboard()))
          : undefined;
      const failure = await workspace.createEntry(requested.destination, type, initial);
      if (failure !== null) {
        error = failure;
        return;
      }
      dialog.close();
      onComplete({ action: "create", entry: { path: requested.destination, kind: type } });
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }
</script>

<dialog
  class="create-dialog"
  bind:this={dialog}
  use:composition.bind
  aria-labelledby="create-entry-title"
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
    <header>
      <p class="eyebrow">{root?.split(/[\\/]/).at(-1) ?? "笔记库"}</p>
      <h2 id="create-entry-title">{title}</h2>
    </header>
    <label class="name-label" for="create-entry-name">名称</label>
    <div class="name-field">
      <input
        id="create-entry-name"
        aria-label="名称"
        class="reader-input"
        bind:this={input}
        bind:value={name}
        disabled={busy}
        autocomplete="off"
        spellcheck="false"
        oninput={() => (error = "")}
        aria-invalid={name !== "" && entryNameError(name) !== null}
      />
      {#if extension && !name.toLowerCase().endsWith(extension)}<span class="extension"
          >{extension}</span
        >{/if}
    </div>
    {#key opening}<DirectoryPicker
        {destinations}
        initialPath={initialDirectory}
        disabled={busy}
        focusOnMount={false}
        confirmLabel="创建"
        onSelect={(path) => {
          directory = path;
          error = "";
        }}
      />{/key}
    <div class="destination" aria-live="polite">
      <span>创建位置</span><strong>{directory === null ? "请选择文件夹" : destination}</strong>
    </div>
    {#if error || validation}<p class="error" role="alert">{error || validation}</p>{/if}
    <footer>
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
        type="submit"
        disabled={busy || workspace.switching || workspace.copying || validation !== null}
        >{busy ? "正在创建…" : "创建"}</button
      >
    </footer>
  </form>
</dialog>

<style>
  .create-dialog {
    width: min(30rem, calc(100vw - 2rem));
    max-height: calc(100dvh - 2rem);
    overflow: auto;
    padding: 1.5rem;
    color: var(--fg);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 1rem;
    box-shadow: 0 12px 48px var(--shadow);
  }
  .create-dialog::backdrop {
    background: var(--scrim);
    backdrop-filter: blur(3px);
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  header {
    margin-bottom: 0.25rem;
  }
  .eyebrow {
    margin: 0 0 0.3rem;
    color: var(--muted);
    font-size: 0.75rem;
  }
  h2 {
    margin: 0;
    font-size: 1.3rem;
    font-weight: 600;
  }
  .name-label {
    font-size: 0.8rem;
    color: var(--muted);
  }
  .name-field {
    display: flex;
    align-items: center;
    gap: 0.65rem;
  }
  .name-field input {
    flex: 1;
    min-width: 0;
  }
  .extension {
    color: var(--muted);
    font-size: 0.75rem;
  }
  .destination {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    padding: 0.75rem;
    background: var(--sidebar);
    border-radius: 0.5rem;
    font-size: 0.8rem;
    overflow-wrap: anywhere;
  }
  .destination span {
    color: var(--muted);
  }
  .destination strong {
    font-weight: 500;
  }
  .error {
    margin: 0;
    color: var(--danger);
    font-size: 0.8rem;
    line-height: 1.5;
  }
  footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.25rem;
  }
  footer button {
    min-width: 5rem;
  }
  @media (max-height: 600px) {
    .create-dialog {
      padding: 1rem;
    }
    form {
      gap: 0.5rem;
    }
    header,
    footer {
      margin: 0;
    }
    .eyebrow {
      display: none;
    }
    h2 {
      font-size: 1.1rem;
    }
    .destination {
      padding: 0.5rem;
    }
    .create-dialog :global(.destination-picker ul) {
      max-height: clamp(4.5rem, calc(100dvh - 380px), 9rem);
    }
    .create-dialog :global(.destination-picker .hint) {
      display: none;
    }
  }
</style>
