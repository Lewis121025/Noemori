<script lang="ts">
  import { previewDocument } from "./preview-document";
  import PreviewFrame from "./PreviewFrame.svelte";
  import type { AgentApi } from "../shared/api";
  let {
    text,
    api,
    name = "页面.html",
    onInspect,
  }: {
    text: string;
    api?: AgentApi | undefined;
    name?: string;
    onInspect?: (() => void) | undefined;
  } = $props();
  let source = $state(false),
    saving = $state(false),
    error = $state("");
  const document = $derived(previewDocument(text));
  async function save(): Promise<void> {
    if (!api || saving) return;
    saving = true;
    error = "";
    try {
      await api.contentSave({ name, bytes: new TextEncoder().encode(text) });
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      saving = false;
    }
  }
</script>

<section class="html-content" aria-label="HTML 内容">
  <PreviewFrame {text} language="html" label="HTML" bind:source {onInspect}>
    {#snippet actions()}{#if api}<button
          class="preview-action"
          type="button"
          disabled={saving}
          onclick={() => void save()}
          aria-label="保存 HTML"
          title="保存 HTML"
          ><svg viewBox="0 0 20 20" aria-hidden="true"
            ><path d="M10 3v10m-4-4 4 4 4-4M4 14v3h12v-3" /></svg
          ></button
        >{/if}
    {/snippet}
    {#snippet feedback()}
      {#if error}<details class="save-error" role="alert">
          <summary>保存失败</summary>
          <p>{error}</p>
        </details>{/if}
    {/snippet}
    <iframe title="HTML 页面预览" sandbox="" srcdoc={document} referrerpolicy="no-referrer"
    ></iframe>
  </PreviewFrame>
</section>

<style>
  .html-content {
    margin: 16px 0;
  }
  iframe {
    height: clamp(180px, 30dvh, 300px);
    background: #fff;
    color-scheme: light;
  }
  .save-error {
    margin: 8px 0;
    color: var(--danger);
    font-size: 12px;
  }
  summary {
    cursor: pointer;
  }
  p {
    overflow-wrap: anywhere;
  }
</style>
