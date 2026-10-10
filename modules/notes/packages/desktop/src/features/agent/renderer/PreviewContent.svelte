<script lang="ts">
  import { PdfPreview, ImagePreview } from "../../reader/renderer/previews";
  import HtmlPreview from "./HtmlPreview.svelte";
  import MediaPlayer from "./MediaPlayer.svelte";
  import { inlineImageBytes } from "../shared/native-media";
  import type { ContentPreview } from "../shared/content";
  import type { AgentApi } from "../shared/api";
  let {
    preview,
    name,
    api,
    onInspect,
  }: {
    preview: ContentPreview;
    name: string;
    api?: AgentApi | undefined;
    onInspect?: (() => void) | undefined;
  } = $props();
  const image = $derived(preview.type === "image" ? inlineImageBytes(preview.url) : null);
  let failed = $state(false);
</script>

<div class="preview-surface">
  {#if preview.type === "pdf"}<PdfPreview bytes={preview.bytes} compact />
  {:else if preview.type === "image" && image}<ImagePreview
      path={image.mime === "image/jpeg"
        ? "图片.jpg"
        : image.mime === "image/svg+xml"
          ? "图片.svg"
          : "图片.png"}
      bytes={image.bytes}
    />
  {:else if preview.type === "image"}{#if failed}<p role="alert">
        图片无法显示，请重新加载或打开原链接。
      </p>{:else}<img
        src={preview.url}
        alt={name}
        referrerpolicy="no-referrer"
        onerror={() => (failed = true)}
      />{/if}
  {:else if preview.type === "html"}<HtmlPreview text={preview.text} {name} {api} {onInspect} />
  {:else if preview.type === "audio" || preview.type === "video"}<MediaPlayer
      type={preview.type}
      mime={preview.mime}
      bytes={preview.bytes}
      {onInspect}
    />
  {:else if preview.type === "text"}<pre>{preview.text || "文件为空"}</pre>
    {#if preview.truncated}<p>仅显示前 128 KB，保存文件保留完整内容。</p>{/if}
  {:else}<p>此文件暂不支持直接预览，可保存后查看。</p>{/if}
</div>

<style>
  .preview-surface {
    min-width: 0;
    min-height: 0;
  }
  .preview-surface :global(.attachment-preview) {
    height: clamp(220px, 44dvh, 380px);
    border: 0;
    font-size: 12px;
  }
  .preview-surface :global(.attachment-preview.compact) {
    height: clamp(220px, 44dvh, 380px);
  }
  .preview-surface :global(.preview-toolbar) {
    font-size: 11px;
    gap: 4px;
  }
  .preview-surface :global(.preview-toolbar button),
  .preview-surface :global(.preview-toolbar input) {
    padding: 3px 6px;
  }
  .preview-surface :global(.html-content) {
    margin: 0;
    border: 0;
    border-radius: 0;
  }
  pre {
    margin: 0;
    padding: 12px;
    max-height: 20rem;
    overflow: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font:
      12px/1.75 "JetBrains Mono Variable",
      monospace;
    user-select: text;
  }
  img {
    display: block;
    width: 100%;
    max-height: 22rem;
    object-fit: contain;
  }
  p {
    margin: 0;
    padding: 12px;
    font-size: 12px;
    line-height: 1.6;
    color: var(--muted);
    overflow-wrap: anywhere;
  }
  p[role="alert"] {
    color: var(--danger);
  }
</style>
