<script lang="ts">
  import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
  import type { PdfPageRender } from "../../engine/media/pdf";
  import PreviewZoom from "./PreviewZoom.svelte";
  import "pdfjs-dist/web/pdf_viewer.css";
  import "./preview.css";

  let { bytes, compact = false }: { bytes: Uint8Array; compact?: boolean } = $props();
  let pdf = $state.raw<PDFDocumentProxy | null>(null);
  let page = $state.raw<PDFPageProxy | null>(null);
  let pageNumber = $state(1);
  let zoom = $state<number | null>(null);
  let width = $state(0);
  let height = $state(0);
  let host: HTMLDivElement | undefined = $state();
  let error = $state("");
  let rendering = $state(false);
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
    error = "";
    passwordRequest = null;
    void (async () => {
      try {
        const { openPdf } = await import("../../engine/media/pdf");
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
    let render: PdfPageRender | undefined;
    const surface = document.createElement("div");
    surface.className = "pdf-page";
    target.replaceChildren(surface);
    rendering = true;
    error = "";
    void (async () => {
      try {
        const { renderPdfPage } = await import("../../engine/media/pdf");
        if (!active) return;
        render = renderPdfPage(currentPage, currentScale, surface);
        await render.promise;
      } catch (cause) {
        if (active)
          error = `无法显示此页：${cause instanceof Error ? cause.message : String(cause)}`;
      } finally {
        if (active) rendering = false;
      }
    })();
    return () => {
      active = false;
      rendering = false;
      render?.cancel();
      surface.remove();
    };
  });

  function goToPage(value: string): void {
    const next = Number(value);
    if (pdf !== null && Number.isInteger(next) && next >= 1 && next <= pdf.numPages)
      pageNumber = next;
  }
</script>

<section class="attachment-preview" class:compact aria-label="PDF 预览">
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
  <div class="preview-viewport" bind:clientWidth={width} bind:clientHeight={height}>
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
    {:else if page === null}
      <p class="preview-message" role="status">正在加载 PDF…</p>
    {/if}
    <div
      class="preview-stage"
      class:concealed={page === null || error !== "" || rendering}
      aria-label={`第 ${pageNumber} 页内容`}
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
