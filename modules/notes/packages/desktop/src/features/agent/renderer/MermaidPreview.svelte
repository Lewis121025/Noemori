<script lang="ts" module>
  let sequence = 0;
</script>

<script lang="ts">
  import { onMount } from "svelte";
  import { renderMermaid } from "../../reader/renderer/previews";
  import { diagramPreview, type DiagramPreview } from "./diagram-preview";
  import PreviewFrame from "./PreviewFrame.svelte";

  /** 一个源码快照只处于一种排版状态，失败不能同时携带旧预览。 */
  type PreviewState =
    | { status: "pending" }
    | ({ status: "ready" } & DiagramPreview)
    | { status: "failed"; message: string };

  let {
    text,
    onInspect,
  }: {
    text: string;
    onInspect?: (() => void) | undefined;
  } = $props();
  let source = $state(false),
    dark = $state(false);
  let preview = $state<PreviewState>({ status: "pending" });
  onMount(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => {
      dark = media.matches;
    };
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  });
  $effect(() => {
    const value = text,
      theme = dark;
    const controller = new AbortController();
    preview = { status: "pending" };
    // 流式消息每次变化都会使旧结果失效，只排版暂停输入后的快照。
    const timer = setTimeout(() => {
      if (!value.trim()) {
        preview = { status: "failed", message: "空白图表" };
        return;
      }
      void draw(value, theme, controller.signal);
    }, 250);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  });

  async function draw(value: string, theme: boolean, signal: AbortSignal): Promise<void> {
    try {
      const svg = await renderMermaid(
        `noemori-message-mermaid-${++sequence}`,
        value,
        theme,
        signal,
      );
      if (!signal.aborted) preview = { status: "ready", ...diagramPreview(svg, theme) };
    } catch (cause) {
      if (!signal.aborted)
        preview = {
          status: "failed",
          message: `图表无法渲染：${cause instanceof Error ? cause.message : String(cause)}`,
        };
    }
  }
</script>

<section class="mermaid-content" aria-label="Mermaid 图表">
  <PreviewFrame
    {text}
    language="mermaid"
    label="图表"
    bind:source
    busy={preview.status === "pending"}
    {onInspect}
  >
    {#if preview.status === "failed"}
      <div class="preview-error" role="status">
        <details class="preview-issue">
          <summary title="查看错误详情"
            ><svg viewBox="0 0 20 20" aria-hidden="true"
              ><circle cx="10" cy="10" r="7" /><path d="M10 6v5m0 3h.01" /></svg
            >暂无法预览</summary
          >
          <pre>{preview.message}</pre>
        </details>
      </div>
    {:else if preview.status === "ready"}
      <iframe
        title="Mermaid 图表"
        sandbox=""
        srcdoc={preview.document}
        referrerpolicy="no-referrer"
        style:aspect-ratio={preview.aspectRatio}
      ></iframe>
    {:else}<div class="preview-loading" role="status" aria-label="正在绘制图表"></div>{/if}
  </PreviewFrame>
</section>

<style>
  .mermaid-content {
    margin: 16px 0;
  }
  iframe {
    height: auto;
    min-height: 136px;
    max-height: min(60dvh, 480px);
  }
  .preview-loading,
  .preview-error {
    display: grid;
    place-items: center;
    min-height: 136px;
  }
  .preview-loading::after {
    content: "";
    width: 16px;
    height: 16px;
    border: 1.5px solid color-mix(in srgb, var(--fg) 10%, transparent);
    border-top-color: var(--muted);
    border-radius: 50%;
    animation: loading 1.2s linear infinite;
  }
  .preview-issue {
    max-width: 100%;
    padding: 14px 18px;
    box-sizing: border-box;
    color: var(--muted);
    font-size: 12px;
  }
  summary {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    list-style: none;
    cursor: pointer;
  }
  summary::-webkit-details-marker {
    display: none;
  }
  summary:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 4px;
    border-radius: 4px;
  }
  summary svg {
    width: 15px;
    height: 15px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
    stroke-linecap: round;
  }
  pre {
    margin: 14px 0 0;
    max-height: 12rem;
    overflow: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font:
      11px/1.6 "JetBrains Mono Variable",
      monospace;
  }
  @keyframes loading {
    to {
      transform: rotate(1turn);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .preview-loading::after {
      animation: none;
    }
  }
</style>
