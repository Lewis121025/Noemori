<script lang="ts">
  import PdfPreview from "./PdfPreview.svelte";
  import { isRemoteMediaSrc, type MediaKind, type MediaIo } from "../../engine/media/media";

  let {
    from,
    src,
    kind,
    onOpen,
    io,
  }: {
    from: string;
    src: string;
    kind: MediaKind;
    onOpen: () => void;
    io: Pick<MediaIo, "resolveLink" | "readFile">;
  } = $props();
  let bytes = $state.raw<Uint8Array | null>(null);
  let error = $state("");

  $effect(() => {
    const origin = from;
    const raw = src;
    const linkKind = kind;
    let active = true;
    bytes = null;
    error = "";
    void (async () => {
      try {
        if (isRemoteMediaSrc(raw)) throw new Error("仅支持预览笔记库内的 PDF");
        const path = await io.resolveLink(origin, raw, linkKind);
        if (!active) return;
        if (path === null) throw new Error("找不到 PDF 文件");
        const loaded = await io.readFile(path);
        if (active) bytes = loaded;
      } catch (cause) {
        if (active) error = cause instanceof Error ? cause.message : String(cause);
      }
    })();
    return () => {
      active = false;
    };
  });
</script>

<div class="pdf-embed">
  <div class="embed-header">
    <span>{src}</span><button type="button" onclick={onOpen}>打开附件</button>
  </div>
  {#if error !== ""}
    <p role="alert">{error}</p>
  {:else if bytes !== null}
    <PdfPreview {bytes} compact />
  {:else}
    <p role="status">正在读取 PDF…</p>
  {/if}
</div>

<style>
  .pdf-embed {
    margin: 0.75rem 0;
    font:
      0.875rem system-ui,
      sans-serif;
  }
  .embed-header {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    align-items: center;
    padding: 0.5rem 0;
  }
  .embed-header span {
    overflow-wrap: anywhere;
    min-width: 0;
  }
  button {
    font: inherit;
    color: inherit;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 0.25rem;
    padding: 0.25rem 0.5rem;
    white-space: nowrap;
    cursor: pointer;
  }
</style>
