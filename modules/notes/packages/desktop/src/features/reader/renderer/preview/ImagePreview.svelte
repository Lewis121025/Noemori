<script lang="ts">
  import { onDestroy, tick, untrack, type Snippet } from "svelte";
  import { captureViewportAnchor, restoreViewportAnchor } from "./viewport-anchor";
  import { mimeFromPath } from "./media";
  import PreviewZoom from "./PreviewZoom.svelte";
  import "./preview.css";

  let {
    path,
    bytes,
    registerToolbar,
  }: {
    path: string;
    bytes: Uint8Array;
    /** 独立预览保留原工具栏，工作区预览交由左侧栏呈现。 */
    registerToolbar?: (toolbar: Snippet | null) => void;
  } = $props();
  let url = $state("");
  let loaded = $state(false);
  let failed = $state(false);
  let naturalWidth = $state(0);
  let naturalHeight = $state(0);
  let width = $state(0);
  let height = $state(0);
  let zoom = $state<number | null>(null);
  let viewport: HTMLDivElement;
  let picture = $state<HTMLImageElement>();
  let zoomEpoch = 0;
  let drag = $state<{ pointerId: number; x: number; y: number; left: number; top: number } | null>(
    null,
  );
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
    zoomEpoch++;
    untrack(finishDrag);
    return () => URL.revokeObjectURL(created);
  });

  function startDrag(event: PointerEvent): void {
    if (event.button !== 0 || event.pointerType === "touch" || drag !== null || !loaded || failed)
      return;
    event.preventDefault();
    viewport.focus({ preventScroll: true });
    zoomEpoch++;
    drag = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: viewport.scrollLeft,
      top: viewport.scrollTop,
    };
    viewport.setPointerCapture(event.pointerId);
  }

  function moveDrag(event: PointerEvent): void {
    if (drag?.pointerId !== event.pointerId) return;
    viewport.scrollLeft = drag.left + drag.x - event.clientX;
    viewport.scrollTop = drag.top + drag.y - event.clientY;
  }
  function finishDrag(event?: PointerEvent): void {
    if (drag === null || (event && drag.pointerId !== event.pointerId)) return;
    const pointerId = drag.pointerId;
    drag = null;
    if (viewport.hasPointerCapture(pointerId)) viewport.releasePointerCapture(pointerId);
  }
  function cancelDrag(event: KeyboardEvent): void {
    if (event.key !== "Escape" || drag === null) return;
    event.preventDefault();
    event.stopPropagation();
    viewport.scrollLeft = drag.left;
    viewport.scrollTop = drag.top;
    finishDrag();
  }
  function changeZoom(value: number | null): void {
    const image = picture;
    const anchor = image ? captureViewportAnchor(viewport, image) : null;
    const epoch = ++zoomEpoch;
    zoom = value;
    void tick().then(() => {
      if (epoch === zoomEpoch && image?.isConnected && anchor)
        restoreViewportAnchor(viewport, image, anchor);
    });
  }
  onDestroy(() => {
    zoomEpoch++;
    finishDrag();
  });
  $effect(() => {
    const register = registerToolbar;
    if (!register) return;
    register(previewTools);
    return () => register(null);
  });
</script>

{#snippet previewTools()}
  <div class="preview-toolbar">
    <PreviewZoom
      {scale}
      disabled={!loaded || failed}
      onChange={changeZoom}
      onFit={() => changeZoom(null)}
    />
    {#if loaded && !failed}<span class="preview-dimensions">{naturalWidth} × {naturalHeight}</span
      >{/if}
  </div>
{/snippet}

<section class="attachment-preview" aria-label="图片预览">
  {#if registerToolbar === undefined}{@render previewTools()}{/if}
  <!-- 可滚动画布接收焦点，以支持原生键盘滚动和取消当前拖动。 -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div
    class="preview-viewport"
    role="region"
    tabindex="0"
    class:dragging={drag !== null}
    aria-label="图片画布"
    bind:this={viewport}
    bind:clientWidth={width}
    bind:clientHeight={height}
    onpointerdown={startDrag}
    onpointermove={moveDrag}
    onpointerup={finishDrag}
    onpointercancel={finishDrag}
    onlostpointercapture={finishDrag}
    onkeydown={cancelDrag}
  >
    {#if failed}
      <p class="preview-message" role="alert">图片无法显示，文件可能已损坏或格式不受支持。</p>
    {:else}
      {#if !loaded}<p class="preview-message" role="status">正在加载图片…</p>{/if}
      <div class="preview-stage">
        {#if url !== ""}
          <img
            bind:this={picture}
            src={url}
            alt={path}
            title={loaded ? `${naturalWidth} × ${naturalHeight}` : undefined}
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
  .dragging img {
    cursor: grabbing;
  }
  img.loading {
    visibility: hidden;
  }
  .preview-viewport:focus-visible {
    outline-offset: -3px;
  }
</style>
