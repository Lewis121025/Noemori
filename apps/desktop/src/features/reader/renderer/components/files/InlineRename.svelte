<script lang="ts">
  import { onMount, untrack } from "svelte";
  import type { VaultEntry } from "../../../shared/api";
  import { createCompositionGuard } from "../../engine/editing/composition";
  import { entryNameError, parentDirectory } from "../../engine/navigation/file-tree";

  let {
    entry,
    entries,
    errorId,
    onRename,
    onIssue,
    onFinish,
  }: {
    entry: VaultEntry;
    entries: VaultEntry[];
    errorId: string;
    /** 复用工作区保存门禁；返回可重试错误，null 表示已提交。 */
    onRename: (from: string, to: string) => Promise<string | null>;
    onIssue: (issue: string) => void;
    /** destination 为 null 表示取消；focus 仅在用户仍停留于此输入时交还目录焦点。 */
    onFinish: (destination: string | null, focus: boolean) => void;
  } = $props();
  // 一次挂载对应一个固定条目；清单刷新只能影响校验，不能改变正在编辑的名称。
  let name = $state(untrack(() => entry.path.split("/").at(-1) ?? ""));
  let error = $state("");
  let busy = $state(false);
  let input: HTMLInputElement;
  const composition = createCompositionGuard();
  const parent = $derived(parentDirectory(entry.path));
  const destination = $derived(parent === "" ? name : `${parent}/${name}`);
  const validation = $derived(
    entryNameError(name) ??
      (destination !== entry.path && entries.some((item) => item.path === destination)
        ? "此位置已有同名条目，请换一个名称。"
        : null),
  );
  const issue = $derived(validation ?? error);

  $effect(() => onIssue(issue));
  onMount(() => {
    input.focus({ preventScroll: true });
    const dot = name.lastIndexOf(".");
    input.setSelectionRange(0, entry.kind === "file" && dot > 0 ? dot : name.length);
  });

  async function submit(): Promise<void> {
    if (busy || composition.active || validation !== null) return;
    if (destination === entry.path) {
      onFinish(null, true);
      return;
    }
    const requested = destination;
    busy = true;
    error = "";
    try {
      const result = await onRename(entry.path, requested);
      if (result === null)
        onFinish(
          requested,
          document.activeElement === input || document.activeElement === document.body,
        );
      else error = result;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }

  function keydown(event: KeyboardEvent): void {
    // 文本编辑的快捷键属于名称输入；不能继续冒泡为目录删除或工作区命令。
    event.stopPropagation();
    if (composition.active) return;
    if (event.key === "Enter" || event.key === "Escape") {
      event.preventDefault();
      if (busy) return;
      if (event.key === "Enter") void submit();
      else onFinish(null, true);
    }
  }
</script>

<input
  class="inline-rename"
  aria-label={entry.kind === "directory" ? "重命名文件夹" : "重命名文件"}
  aria-invalid={!!issue}
  aria-describedby={issue ? errorId : undefined}
  aria-busy={busy}
  title="Enter 保存，Escape 取消"
  autocomplete="off"
  spellcheck="false"
  readonly={busy}
  bind:this={input}
  bind:value={name}
  use:composition.bind
  oninput={() => {
    error = "";
  }}
  onkeydown={keydown}
  onblur={() => {
    if (!busy) onFinish(null, false);
  }}
/>

<style>
  .inline-rename {
    width: 100%;
    min-width: 0;
    margin-left: -0.15rem;
    padding: 0.15rem;
    border: 1px solid var(--accent);
    border-radius: 0.25rem;
    outline: none;
    color: var(--fg);
    background: var(--bg);
    font: inherit;
  }
  .inline-rename[aria-invalid="true"] {
    border-color: var(--danger);
  }
  .inline-rename[readonly] {
    opacity: 0.65;
  }
</style>
