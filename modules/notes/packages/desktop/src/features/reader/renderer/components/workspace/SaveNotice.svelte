<script lang="ts">
  import type { ReaderDocument } from "../../state/document.svelte";
  import type { EditorSnapshot } from "../../engine/markdown/source-session";
  let {
    doc,
    copying,
    saveCopy,
    requestSave,
    snapshot,
  }: {
    doc: ReaderDocument;
    copying: boolean;
    saveCopy: () => Promise<void>;
    requestSave: () => void;
    snapshot: () => EditorSnapshot;
  } = $props();
  const decoder = new TextDecoder();
  const issue = $derived(doc.saveError ?? doc.conflict?.error);
  let current = $state("");
  let comparisonError = $state("");
  let comparisonRevision = $state(-1);

  function readCurrent(event: Event): void {
    if (!(event.currentTarget instanceof HTMLDetailsElement) || !event.currentTarget.open) return;
    refreshComparison();
  }

  function refreshComparison(): void {
    try {
      current = decoder.decode(snapshot().bytes);
      comparisonRevision = doc.editRevision;
      comparisonError = "";
    } catch (error) {
      comparisonError = error instanceof Error ? error.message : String(error);
    }
  }
</script>

<section class="save-notice" aria-label="保存需要处理">
  <p role="alert">
    {#if doc.needsSourceRepair}
      当前内容暂时无法保真保存为
      Markdown，原文件未改动。请撤销最后一次结构操作，或调整该处内容后重试。
    {:else if doc.conflict !== null}
      {doc.conflict.error !== undefined
        ? "原文件暂时无法读取。"
        : doc.conflict.disk === null
          ? "原文件已在其他地方删除。"
          : "原文件已在其他地方修改。"}
      当前编辑仍保留，可另存副本以保留两份内容。
    {:else}
      保存失败。当前编辑仍保留，请重试或另存副本。
    {/if}
  </p>
  {#if issue && doc.needsSourceRepair}<p class="save-error" role="status">{issue}</p>{/if}
  <div class="save-actions">
    {#if !doc.needsSourceRepair}<button
        class="reader-button primary"
        type="button"
        onclick={() => void saveCopy()}
        disabled={doc.saving || copying}>另存为副本</button
      >{/if}
    <button
      class="reader-button"
      class:primary={doc.needsSourceRepair}
      type="button"
      onclick={requestSave}
      disabled={doc.saving || copying}>重试保存</button
    >
  </div>
  {#if issue && !doc.needsSourceRepair}
    <details class="error-details">
      <summary>查看详细原因</summary>
      <p class="save-error">{issue}</p>
    </details>
  {/if}
  {#if doc.conflict?.disk != null}
    <details ontoggle={readCurrent}>
      <summary>对比磁盘与当前编辑</summary>
      {#if comparisonRevision !== doc.editRevision}
        <p class="comparison-stale" role="status">编辑已变化，刷新对比以查看最新内容。</p>
      {/if}
      <button class="reader-button" type="button" onclick={refreshComparison}>刷新对比</button>
      <div class="comparison">
        <section aria-label="磁盘版本">
          <h3>磁盘版本</h3>
          <pre>{decoder.decode(doc.conflict.disk)}</pre>
        </section>
        <section aria-label="编辑快照">
          <h3>本次对比的编辑快照</h3>
          {#if comparisonError}<p role="alert">{comparisonError}</p>{:else}<pre>{current}</pre>{/if}
        </section>
      </div>
    </details>
  {/if}
</section>

<style>
  .comparison {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 1rem;
  }
  .comparison h3 {
    font-size: 0.85rem;
    font-weight: 600;
  }
  .comparison pre {
    padding: 0.75rem;
    background: var(--sidebar);
    border-radius: 0.5rem;
  }
  @media (max-width: 800px) {
    .comparison {
      grid-template-columns: 1fr;
    }
  }
  .save-notice {
    border: 1px solid var(--border);
    border-left: 3px solid var(--warning);
    border-radius: 0.5rem;
    padding: 0.85rem 1rem;
  }
  .save-notice p {
    margin: 0 0 0.75rem;
  }
  .save-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .save-notice details {
    margin-top: 0.75rem;
  }
  .save-notice summary {
    min-height: 32px;
    align-content: center;
    cursor: pointer;
  }
  .save-notice pre {
    max-height: 14rem;
    overflow: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .save-error {
    font-size: 0.875rem;
    overflow-wrap: anywhere;
  }
  .error-details {
    color: var(--muted);
    font-size: 0.8rem;
  }
  .error-details .save-error {
    margin: 0.5rem 0 0;
  }
</style>
