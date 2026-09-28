<script lang="ts">
  import { mimeFromPath } from "../../engine/media/media";
  import PreviewZoom from "./PreviewZoom.svelte";
  import "./preview.css";

  let { path, bytes }: { path: string; bytes: Uint8Array } = $props();
  let url = $state("");
  let loaded = $state(false);
  let failed = $state(false);
  let naturalWidth = $state(0);
  let naturalHeight = $state(0);
  let width = $state(0);
  let height = $state(0);
  let zoom = $state<number | null>(null);
  let viewport: HTMLDivElement;
  let drag: { x: number; y: number; left: number; top: number } | null = null;
  const scale = $derived(
    zoom ??
      (loaded
        ? Math.min(
            1,
            Math.max(1, width - 32) / naturalWidth,
            Math.max(1, height - 32) / naturalHeight,
          )
        : 1),
  );

  $effect(() => {
    const created = URL.createObjectURL(
      new Blob([new Uint8Array(bytes)], { type: mimeFromPath(path) }),
    );
    url = created;
    loaded = false;
    failed = false;
    zoom = null;
    return () => URL.revokeObjectURL(created);
  });

  function startDrag(event: PointerEvent): void {
    if (event.button !== 0 || event.pointerType === "touch") return;
    drag = {
      x: event.clientX,
      y: event.clientY,
      left: viewport.scrollLeft,
      top: viewport.scrollTop,
    };
    viewport.setPointerCapture(event.pointerId);
  }

  function moveDrag(event: PointerEvent): void {
    if (drag === null) return;
    viewport.scrollLeft = drag.left + drag.x - event.clientX;
    viewport.scrollTop = drag.top + drag.y - event.clientY;
  }
</script>

<section class="attachment-preview" aria-label="图片预览">
  <div class="preview-toolbar">
    <PreviewZoom
      {scale}
      disabled={!loaded || failed}
      onChange={(value) => (zoom = value)}
      onFit={() => (zoom = null)}
    />
    {#if loaded && !failed}<span>{naturalWidth} × {naturalHeight}</span>{/if}
  </div>
  <div
    class="preview-viewport"
    role="region"
    aria-label="图片画布"
    bind:this={viewport}
    bind:clientWidth={width}
    bind:clientHeight={height}
    onpointerdown={startDrag}
    onpointermove={moveDrag}
    onpointerup={() => (drag = null)}
    onpointercancel={() => (drag = null)}
    onlostpointercapture={() => (drag = null)}
  >
    {#if failed}
      <p class="preview-message" role="alert">图片无法显示，文件可能已损坏或格式不受支持。</p>
    {:else}
      {#if !loaded}<p class="preview-message" role="status">正在加载图片…</p>{/if}
      <div class="preview-stage">
        {#if url !== ""}
          <img
            src={url}
            alt={path}
            draggable="false"
            class:loading={!loaded}
            style:width={loaded ? `${naturalWidth * scale}px` : undefined}
            style:height={loaded ? `${naturalHeight * scale}px` : undefined}
            onload={(event) => {
              if (!(event.currentTarget instanceof HTMLImageElement)) return;
              naturalWidth = event.currentTarget.naturalWidth;
              naturalHeight = event.currentTarget.naturalHeight;
              loaded = naturalWidth > 0 && naturalHeight > 0;
              failed = !loaded;
            }}
            onerror={() => (failed = true)}
          />
        {/if}
      </div>
    {/if}
  </div>
</section>

<style>
  img {
    display: block;
    max-width: none;
    user-select: none;
    cursor: grab;
  }
  img:active {
    cursor: grabbing;
  }
  img.loading {
    visibility: hidden;
  }
</style>
