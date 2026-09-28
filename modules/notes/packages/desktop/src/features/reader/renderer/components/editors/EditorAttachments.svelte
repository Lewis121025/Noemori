<script lang="ts">
  import type { EditorView } from "prosemirror-view";
  import type {
    AttachmentProgress,
    createAttachmentEditing,
  } from "../../engine/editing/attachments";

  let {
    view,
    editing,
    progress,
  }: {
    view: EditorView;
    editing: ReturnType<typeof createAttachmentEditing>;
    progress: AttachmentProgress;
  } = $props();
  let input: HTMLInputElement;

  /** 打开系统文件选择器前捕获正文位置；取消选择不修改文档。 */
  export function pick(): void {
    if (!editing.prepare(view)) return;
    input.click();
  }
</script>

<input
  bind:this={input}
  type="file"
  multiple
  hidden
  aria-label="选择要插入的附件"
  onchange={() => {
    const files = Array.from(input.files ?? []);
    input.value = "";
    view.focus();
    void editing.insertFiles(view, files);
  }}
  oncancel={() => {
    editing.dismiss(view);
    view.focus();
  }}
/>
{#if progress}
  <aside class="attachment-progress reader-popover" aria-label="附件导入">
    {#if progress.status === "importing"}
      <p role="status">正在导入 {progress.completed + 1}/{progress.total}：{progress.name}</p>
      <progress aria-label="已导入附件数" value={progress.completed} max={progress.total}
      ></progress>
    {:else}
      <p role="alert">{progress.message}</p>
      <div class="actions">
        <button
          class="reader-button"
          type="button"
          onclick={() => {
            view.focus();
            void editing.retry(view);
          }}>重试剩余附件</button
        >
        <button
          class="reader-button"
          type="button"
          onclick={() => {
            editing.dismiss(view);
            view.focus();
          }}>关闭</button
        >
      </div>
    {/if}
  </aside>
{/if}

<style>
  .attachment-progress {
    position: fixed;
    inset: auto 1rem 2.5rem auto;
    width: min(28rem, calc(100vw - 2rem));
    padding: 0.75rem 1rem;
    z-index: 10;
    font-size: 0.85rem;
    overflow-wrap: anywhere;
  }
  p {
    margin: 0;
  }
  progress {
    width: 100%;
    height: 4px;
    margin-top: 0.5rem;
    accent-color: var(--accent);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-top: 0.75rem;
  }
</style>
