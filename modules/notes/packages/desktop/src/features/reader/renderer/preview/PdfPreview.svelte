<script lang="ts">
  import { revealOnChange } from "../motion";
  import type { Snippet } from "svelte";
  import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
  import type { PdfPageRender } from "./pdf";
  import { captureViewportAnchor, restoreViewportAnchor } from "./viewport-anchor";
  import PreviewZoom from "./PreviewZoom.svelte";
  import "pdfjs-dist/web/pdf_viewer.css";
  import "./preview.css";

  let {
    bytes,
    compact = false,
    registerToolbar,
  }: {
    bytes: Uint8Array;
    compact?: boolean;
    /** 嵌入预览保留就地导航，独立文档的操作交由左侧栏呈现。 */
    registerToolbar?: (toolbar: Snippet | null) => void;
  } = $props();
  let pdf = $state.raw<PDFDocumentProxy | null>(null);
  let page = $state.raw<PDFPageProxy | null>(null);
  let pageNumber = $state(1);
  let zoom = $state<number | null>(null);
  let width = $state(0);
  let height = $state(0);
  let host: HTMLDivElement | undefined = $state();
  let error = $state("");
  let rendering = $state(false);
  let hasFrame = $state(false);
  let displayedPage = $state(1);
  let committed: PdfPageRender | undefined;
  let committedSurface: HTMLElement | undefined;
  let viewport: HTMLDivElement;
  let password = $state("");
  let passwordRequest = $state.raw<{
    submit: (password: string) => void;
    incorrect: boolean;
  } | null>(null);
  const size = $derived(page?.getViewport({ scale: 1 }));
  const scale = $derived(
    zoom ??
      (size
        ? Math.min(Math.max(1, width - 32) / size.width, Math.max(1, height - 32) / size.height)
        : 1),
  );
  const renderScale = $derived(width > 0 && height > 0 ? scale : null);

  $effect(() => {
    const data = bytes;
    let active = true;
    let task: PDFDocumentLoadingTask | undefined;
    pdf = null;
    page = null;
    pageNumber = 1;
    zoom = null;
    hasFrame = false;
    error = "";
    passwordRequest = null;
    void (async () => {
      try {
        const { openPdf } = await import("./pdf");
        if (!active) return;
        task = openPdf(data, (submit, incorrect) => {
          if (!active) return;
          password = "";
          passwordRequest = { submit, incorrect };
        });
        const loaded = await task.promise;
        if (active) pdf = loaded;
      } catch (cause) {
        if (active)
          error = `PDF 无法读取：${cause instanceof Error ? cause.message : String(cause)}`;
      }
    })();
    return () => {
      active = false;
      committed?.cancel();
      committed = undefined;
      committedSurface = undefined;
      // 销毁同时终止解析、密码等待与工作线程；任务失败已由上面的 catch 呈现。
      void task?.destroy().catch(() => undefined);
    };
  });

  $effect(() => {
    const document = pdf;
    const number = pageNumber;
    let active = true;
    page = null;
    if (document === null) return;
    error = "";
    void document
      .getPage(number)
      .then((loaded) => {
        if (active) page = loaded;
      })
      .catch((cause: unknown) => {
        if (active)
          error = `无法加载此页：${cause instanceof Error ? cause.message : String(cause)}`;
      });
    return () => {
      active = false;
    };
  });

  $effect(() => {
    const currentPage = page;
    const target = host;
    const currentScale = renderScale;
    if (currentPage === null || target === undefined || currentScale === null) return;
    let active = true;
    let promoted = false;
    let render: PdfPageRender | undefined;
    const surface = document.createElement("div");
    surface.className = "pdf-page";
    // 待绘制层参与样式计算但不占布局；完成后才交接画面所有权。
    surface.style.position = "absolute";
    surface.style.visibility = "hidden";
    surface.setAttribute("aria-hidden", "true");
    target.append(surface);
    rendering = true;
    error = "";
    void (async () => {
      try {
        const { renderPdfPage } = await import("./pdf");
        if (!active) return;
        render = renderPdfPage(currentPage, currentScale, surface);
        await render.promise;
        if (!active) return;
        const anchor =
          committedSurface && displayedPage === currentPage.pageNumber
            ? captureViewportAnchor(viewport, committedSurface)
            : null;
        committed?.cancel();
        target.replaceChildren(surface);
        surface.style.removeProperty("position");
        surface.style.removeProperty("visibility");
        surface.removeAttribute("aria-hidden");
        committed = render;
        committedSurface = surface;
        promoted = true;
        displayedPage = currentPage.pageNumber;
        hasFrame = true;
        if (anchor) restoreViewportAnchor(viewport, surface, anchor);
      } catch (cause) {
        render?.cancel();
        surface.remove();
        if (active)
          error = `无法显示此页：${cause instanceof Error ? cause.message : String(cause)}`;
      } finally {
        if (active) rendering = false;
      }
    })();
    return () => {
      active = false;
      rendering = false;
      if (!promoted) {
        render?.cancel();
        surface.remove();
      }
    };
  });

  function goToPage(value: string): void {
    const next = Number(value);
    if (pdf !== null && Number.isInteger(next) && next >= 1 && next <= pdf.numPages)
      pageNumber = next;
  }
  $effect(() => {
    const register = registerToolbar;
    if (!register) return;
    register(previewTools);
    return () => register(null);
  });
</script>

{#snippet previewTools()}
  <div class="preview-toolbar">
    <button
      type="button"
      aria-label="上一页"
      disabled={pdf === null || pageNumber <= 1}
      onclick={() => (pageNumber -= 1)}>上一页</button
    >
    <label
      >第 <input
        aria-label="PDF 页码"
        type="number"
        min="1"
        max={pdf?.numPages ?? 1}
        value={pageNumber}
        disabled={pdf === null}
        onchange={(event) => {
          goToPage(event.currentTarget.value);
          event.currentTarget.value = String(pageNumber);
        }}
      />
      / {pdf?.numPages ?? "—"} 页</label
    >
    <button
      type="button"
      aria-label="下一页"
      disabled={pdf === null || pageNumber >= pdf.numPages}
      onclick={() => (pageNumber += 1)}>下一页</button
    >
    <PreviewZoom
      {scale}
      disabled={page === null}
      onChange={(value) => (zoom = value)}
      onFit={() => (zoom = null)}
    />
    {#if rendering}<span role="status">正在渲染…</span>{/if}
  </div>
{/snippet}

<section class="attachment-preview" class:compact aria-label="PDF 预览">
  {#if registerToolbar === undefined}{@render previewTools()}{/if}
  <div
    class="preview-viewport"
    bind:this={viewport}
    bind:clientWidth={width}
    bind:clientHeight={height}
  >
    {#if passwordRequest !== null}
      <form
        class="preview-message"
        onsubmit={(event) => {
          event.preventDefault();
          passwordRequest?.submit(password);
          passwordRequest = null;
          password = "";
        }}
      >
        <p role="status">
          {passwordRequest.incorrect ? "密码不正确，请重新输入。" : "此 PDF 需要密码。"}
        </p>
        <label>密码 <input type="password" bind:value={password} autocomplete="off" /></label>
        <button type="submit">打开 PDF</button>
      </form>
    {:else if error !== ""}
      <p class="preview-message" role="alert">{error}</p>
    {:else if page === null && !hasFrame}
      <p class="preview-message" role="status">正在加载 PDF…</p>
    {/if}
    <div
      class="preview-stage"
      use:revealOnChange={{ key: displayedPage, kind: "media" }}
      class:concealed={!hasFrame || error !== ""}
      aria-label={`第 ${displayedPage} 页内容`}
      aria-busy={rendering}
      bind:this={host}
    ></div>
  </div>
</section>

<style>
  input[type="number"] {
    width: 4.5rem;
  }
  .concealed {
    display: none;
  }
  .preview-stage :global(.pdf-page) {
    position: relative;
    background: white;
    box-shadow: 0 1px 5px #0002;
  }
  .preview-stage :global(canvas) {
    display: block;
  }
</style>
