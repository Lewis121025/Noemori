<script lang="ts">
  import { onMount, untrack } from "svelte";
  import type { ReaderWorkspaceController } from "../workspace/state.svelte";
  import type { ExportFormat, ExportPlan, ExportProgress, ExportResult } from "../../shared/export";
  let { workspace }: { workspace: ReaderWorkspaceController } = $props();
  let dialog: HTMLDialogElement;
  const scope = untrack(() => workspace.exportScope);
  const files = untrack(() =>
    workspace.files.filter(
      (path) =>
        scope?.kind === "vault" ||
        scope?.paths.some((selected) => path === selected || path.startsWith(`${selected}/`)),
    ),
  );
  const hasNotes = files.some((path) => path.toLowerCase().endsWith(".md"));
  const hasBoards = files.some((path) => path.toLowerCase().endsWith(".noemoriboard"));
  let format = $state<ExportFormat>(hasNotes ? "pdf" : hasBoards ? "svg" : "archive");
  let busy = $state(false);
  let stopping = $state(false);
  let progress = $state<ExportProgress | null>(null);
  let plan = $state<ExportPlan | null>(null);
  let result = $state<ExportResult | null>(null);
  let message = $state("");
  const labels: Record<ExportProgress["phase"], string> = {
    saving: "保存当前编辑",
    checking: "检查导出内容",
    snapshotting: "冻结文件内容",
    converting: "转换内容与资源",
    validating: "校验导出结果",
    packaging: "整理导出文件",
    committing: "完成文件提交",
  };
  onMount(() => {
    dialog.showModal();
    return () => {
      if (busy)
        void workspace.cancelExport().catch((error: unknown) => workspace.report(String(error)));
    };
  });
  async function run(): Promise<void> {
    if (busy) return;
    busy = true;
    stopping = false;
    result = null;
    plan = null;
    message = "";
    try {
      result = await workspace.runExport(
        format,
        (value) => {
          progress = value;
        },
        (value) => {
          plan = value;
        },
      );
    } finally {
      busy = false;
    }
  }
  async function cancel(): Promise<void> {
    if (!busy) {
      workspace.exportScope = null;
      return;
    }
    stopping = true;
    try {
      const accepted = await workspace.cancelExport();
      message = accepted ? "正在停止导出并清理临时文件…" : "正在完成提交，请等待最终结果。";
    } catch (error) {
      message = `无法确认取消结果：${String(error)}`;
      stopping = false;
    }
  }
</script>

<dialog
  bind:this={dialog}
  aria-labelledby="export-title"
  oncancel={(event) => {
    event.preventDefault();
    void cancel();
  }}
>
  <form
    onsubmit={(event) => {
      event.preventDefault();
      void run();
    }}
  >
    <h2 id="export-title">{scope?.kind === "vault" ? "导出笔记库" : "导出所选内容"}</h2>
    <p>
      {scope?.kind === "selection"
        ? `已选择 ${scope.paths.length} 项`
        : "整个笔记库"}，关联附件和嵌入内容会一起处理。
    </p>
    <label for="export-format">导出格式</label>
    <select id="export-format" bind:value={format} disabled={busy}>
      {#if hasNotes}
        <option value="pdf">PDF 文档</option>
        <option value="docx">Word 文档（公式可编辑）</option>
        <option value="markdown">通用 Markdown</option>
      {/if}
      {#if hasBoards && !hasNotes}
        <option value="png">白板 PNG 图片</option>
        <option value="svg">白板 SVG 图片</option>
      {/if}
      <option value="archive">原格式归档（ZIP）</option>
    </select>
    <p class="hint">导出前会保存当前编辑。全部内容校验通过后选择保存位置；批量内容将打包为 ZIP。</p>
    {#if busy && progress}
      <div role="status" aria-live="polite">
        <p>
          {labels[progress.phase]}{progress.total === null
            ? "…"
            : `：${progress.completed} / ${progress.total}`}
        </p>
        <progress
          value={progress.total === null ? undefined : progress.completed}
          max={progress.total ?? 1}
        ></progress>
        {#if progress.path}<p class="path">{progress.path}</p>{/if}
      </div>
    {/if}
    {#if plan}
      <details>
        <summary
          >本次包含 {plan.files.length} 个文件，约 {(plan.bytes / 1024 ** 2).toFixed(1)} MiB</summary
        >
        <ul>
          {#each plan.files as path (path)}<li>{path}</li>{/each}
        </ul>
      </details>
    {/if}
    {#if message}<p role="status">{message}</p>{/if}
    {#if result?.status === "saved"}
      <p role="status">导出完成</p>
      <p class="path">{result.path}</p>
      {#if result.warning}<p role="alert">{result.warning}</p>{/if}
      <button class="reader-button" type="button" onclick={() => void workspace.revealExport()}
        >在文件夹中显示</button
      >
    {:else if result?.status === "cancelled"}<p role="status">已取消导出</p>
    {:else if result?.status === "failed"}<p role="alert">导出未完成，请查看以下原因。</p>{/if}
    {#if result && result.status !== "cancelled" && result.issues.length}
      <ul class="issues">
        {#each result.issues as issue, index (index)}<li>
            {issue.path}{issue.line ? `:${issue.line}` : ""}：{issue.message}
          </li>{/each}
      </ul>
    {/if}
    <footer>
      <button
        class="reader-button"
        type="button"
        disabled={busy && stopping}
        onclick={() => void cancel()}>{busy ? "取消导出" : "关闭"}</button
      >
      {#if result?.status !== "saved"}<button
          class="reader-button primary"
          type="submit"
          disabled={busy}>{busy ? "正在导出…" : result ? "重新导出" : "开始导出"}</button
        >{/if}
    </footer>
  </form>
</dialog>

<style>
  dialog {
    width: min(34rem, calc(100vw - 3rem));
    max-height: calc(100dvh - 4rem);
    padding: 1.5rem;
    border: 1px solid var(--border);
    border-radius: 1rem;
    background: var(--bg);
    color: var(--fg);
  }
  dialog::backdrop {
    background: #0005;
  }
  h2 {
    margin: 0 0 1rem;
    font-size: 1.15rem;
  }
  p,
  label,
  li {
    font-size: 0.875rem;
    line-height: 1.6;
  }
  select {
    display: block;
    width: 100%;
    margin-top: 0.5rem;
    padding: 0.6rem;
    color: var(--fg);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 0.5rem;
  }
  .hint {
    color: var(--muted);
  }
  .path,
  li {
    overflow-wrap: anywhere;
  }
  details,
  .issues {
    max-height: 12rem;
    overflow: auto;
  }
  progress {
    width: 100%;
  }
  footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.75rem;
    margin-top: 1.5rem;
  }
  .primary {
    border: 1px solid var(--border);
  }
</style>
