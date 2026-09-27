<script lang="ts">
  /**
   * 链接悬停预览：指针在链接上停留后弹出目标笔记（或其中一节）的只读内容。
   *
   * 开合时机由纯状态机决定；弹层内的链接不再触发预览。滚动、按键与弹层外的
   * 按下都会立即关闭，预览不会挡住正在进行的编辑。
   */
  import type { MediaIo } from "../../engine/media/media";
  import { mountNotePreview } from "../../engine/rendering/content-view";
  import type { OpenContentLink } from "../../engine/editing/link-interaction";
  import {
    createHoverController,
    previewRequestOf,
    previewTargetOf,
    type PreviewTarget,
  } from "../../engine/navigation/hover-preview";

  let {
    host,
    from,
    io,
    openLink,
  }: {
    /** 监听悬停的区域（分栏滚动区）。 */
    host: HTMLElement;
    /** 宿主笔记路径；没有打开文档时不预览。 */
    from: string | null;
    io: MediaIo;
    /** 点击弹层标题时按普通链接打开。 */
    openLink: OpenContentLink;
  } = $props();

  type Hit = { element: Element; target: PreviewTarget; from: string };
  type Shown = Hit & { rect: DOMRect };

  /** 弹层尺寸上限（像素），用于决定放在链接上方还是下方。 */
  const WIDTH = 448;
  const HEIGHT = 320;

  let shown = $state.raw<Shown | null>(null);
  let body: HTMLDivElement | undefined = $state();

  const hover = createHoverController<Hit>({
    show: (hit) => {
      shown = { ...hit, rect: hit.element.getBoundingClientRect() };
    },
    hide: () => {
      shown = null;
    },
    same: (left, right) => left.element === right.element,
  });

  const placement = $derived.by(() => {
    if (shown === null) return "";
    const { rect } = shown;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - WIDTH - 8));
    const below = window.innerHeight - rect.bottom >= HEIGHT + 12 || rect.top < HEIGHT + 12;
    return below
      ? `left:${String(left)}px;top:${String(rect.bottom + 6)}px`
      : `left:${String(left)}px;bottom:${String(window.innerHeight - rect.top + 6)}px`;
  });

  $effect(() => {
    const element = host;
    const inPopover = (target: EventTarget | null) =>
      target instanceof Element && target.closest(".hover-preview") !== null;
    const over = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || from === null) return;
      const hit = previewTargetOf(event.target);
      if (hit !== null) {
        const origin =
          hit.element.closest<HTMLElement>("[data-content-path]")?.dataset["contentPath"] ?? from;
        hover.enterLink({ ...hit, from: origin });
      }
    };
    const out = (event: PointerEvent) => {
      if (!(event.target instanceof Element)) return;
      const hit = previewTargetOf(event.target);
      if (hit === null) return;
      // 在同一链接的子元素之间移动不算离开。
      if (event.relatedTarget instanceof Node && hit.element.contains(event.relatedTarget)) return;
      hover.leaveLink();
    };
    const press = (event: Event) => {
      if (!inPopover(event.target)) hover.dismiss();
    };
    const dismiss = () => hover.dismiss();
    element.addEventListener("pointerover", over);
    element.addEventListener("pointerout", out);
    element.addEventListener("pointerdown", press);
    element.addEventListener("keydown", press);
    element.addEventListener("scroll", dismiss, { passive: true });
    return () => {
      element.removeEventListener("pointerover", over);
      element.removeEventListener("pointerout", out);
      element.removeEventListener("pointerdown", press);
      element.removeEventListener("keydown", press);
      element.removeEventListener("scroll", dismiss);
      hover.dismiss();
    };
  });

  // 文档切换后旧链接的预览不再有意义。
  $effect(() => {
    void from;
    hover.dismiss();
  });

  $effect(() => {
    const current = shown;
    const container = body;
    if (current === null || container === undefined) return;
    const path = current.from;
    container.textContent = "正在载入…";
    const request = previewRequestOf(current.target, path);
    // 预览本身是第一层：宿主不进祖先链，纯锚点预览宿主自身不算循环。
    const preview = mountNotePreview(container, {
      from: path,
      ...request,
      openLink,
      io,
      depth: 0,
      chain: [],
    });
    return preview.destroy;
  });
</script>

{#if shown !== null}
  <div
    class="hover-preview"
    role="region"
    aria-label="链接预览"
    style={placement}
    onpointerenter={() => hover.enterPopover()}
    onpointerleave={() => hover.leavePopover()}
  >
    <button
      type="button"
      class="reader-button title"
      onclick={() => {
        const current = shown;
        hover.dismiss();
        if (current !== null) openLink(current.target.kind, current.target.raw, current.from);
      }}>{shown.target.raw}</button
    >
    <div class="body" bind:this={body}></div>
  </div>
{/if}

<style>
  .hover-preview {
    position: fixed;
    z-index: 20;
    width: min(28rem, calc(100vw - 1rem));
    max-height: 20rem;
    overflow: auto;
    padding: 0.5rem 0.85rem 0.75rem;
    color: var(--fg);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 0.7rem;
    box-shadow:
      0 8px 24px var(--shadow),
      0 16px 48px var(--shadow);
    font-size: 0.9rem;
  }
  .title {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 600;
  }
  .body {
    margin-top: 0.35rem;
  }
  .body :global(.ProseMirror) {
    outline: none;
  }
  .body :global(.ProseMirror :is(h1, h2, h3)) {
    font-size: 1.05rem;
    margin: 0.6em 0 0.3em;
  }
</style>
