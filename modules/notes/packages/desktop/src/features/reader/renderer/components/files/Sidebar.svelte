<script lang="ts">
  /**
   * 文件栏宽度可拖拽调整；隐藏时保留挂载，避免丢失目录展开和搜索状态。
   */
  import type { Snippet } from "svelte";
  import { SIDEBAR_LAYOUT } from "../../../shared/api";

  type Props = {
    /** 当前宽度（像素）。 */
    width: number;
    /** 拖拽结束或键盘调整后提交宽度，避免每次指针移动都写入会话。 */
    onWidth: (width: number) => void;
    children: Snippet;
    hidden?: boolean;
  };

  let { width, onWidth, children, hidden = false }: Props = $props();
  let resize = $state<{
    pointerId: number;
    startX: number;
    startWidth: number;
    width: number;
  } | null>(null);

  function clampWidth(value: number): number {
    return Math.min(SIDEBAR_LAYOUT.maxWidth, Math.max(SIDEBAR_LAYOUT.minWidth, Math.round(value)));
  }
  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || !(event.currentTarget instanceof HTMLElement)) return;
    event.preventDefault();
    resize = { pointerId: event.pointerId, startX: event.clientX, startWidth: width, width };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function onPointerMove(event: PointerEvent): void {
    if (resize?.pointerId !== event.pointerId) return;
    resize.width = clampWidth(resize.startWidth + event.clientX - resize.startX);
  }
  function onPointerUp(event: PointerEvent): void {
    if (resize?.pointerId !== event.pointerId) return;
    const next = resize.width;
    resize = null;
    if (event.currentTarget instanceof HTMLElement)
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (next !== width) onWidth(next);
  }
  function onKeydown(event: KeyboardEvent): void {
    const next =
      event.key === "ArrowLeft"
        ? width - 10
        : event.key === "ArrowRight"
          ? width + 10
          : event.key === "Home"
            ? SIDEBAR_LAYOUT.minWidth
            : event.key === "End"
              ? SIDEBAR_LAYOUT.maxWidth
              : null;
    if (next === null) return;
    event.preventDefault();
    onWidth(clampWidth(next));
  }
</script>

<aside {hidden} class="file-sidebar" style:width="{resize?.width ?? width}px" aria-label="文件栏">
  <div class="body">{@render children()}</div>
  <!-- 按 WAI-ARIA 分隔条模式，带范围值的 separator 需要键盘焦点；Svelte 将该角色一律归为静态元素。 -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div
    class="resize"
    class:resizing={resize !== null}
    role="separator"
    tabindex="0"
    aria-label="调整侧栏宽度"
    aria-orientation="vertical"
    aria-valuemin={SIDEBAR_LAYOUT.minWidth}
    aria-valuemax={SIDEBAR_LAYOUT.maxWidth}
    aria-valuenow={resize?.width ?? width}
    title="拖动调整宽度，双击恢复默认；也可使用左右方向键"
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onpointercancel={() => {
      resize = null;
    }}
    onlostpointercapture={() => {
      resize = null;
    }}
    onkeydown={onKeydown}
    ondblclick={() => onWidth(SIDEBAR_LAYOUT.leftWidth)}
  ></div>
</aside>

<style>
  .file-sidebar[hidden] {
    display: none;
  }
  .file-sidebar {
    position: relative;
    flex-shrink: 0;
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
  }

  .body {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
  }

  .resize {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 6px;
    padding: 0;
    border: none;
    background: transparent;
    cursor: col-resize;
    right: 0;
    touch-action: none;
    outline-offset: -2px;
  }
  .resize:hover,
  .resize:focus-visible,
  .resize.resizing {
    background: color-mix(in srgb, var(--accent) 35%, transparent);
  }

  @media (max-width: 640px) {
    .file-sidebar {
      position: absolute;
      inset: 0 auto 0 0;
      z-index: 2;
      max-width: 80%;
      box-shadow: 8px 0 24px var(--shadow);
    }
  }
</style>
