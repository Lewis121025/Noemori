<script lang="ts">
  import { untrack, type Snippet } from "svelte";
  import type { WhiteboardEditorApi } from "../editor/editor-api";
  import { nativeInputOwnsHistory } from "../editor/history";
  import {
    serializeWhiteboard,
    type InkPoint,
    type WhiteboardDocument,
  } from "../../shared/whiteboard/model";
  import { strokePath } from "../../shared/whiteboard/geometry";
  import { WhiteboardInput } from "./input";
  import type { ShapeRepair } from "../../shared/whiteboard/recognition";

  let {
    board,
    epoch,
    register,
    onDirty,
    readOnly = false,
    registerToolbar,
    repair,
  }: {
    board: WhiteboardDocument;
    epoch: number;
    register: (api: WhiteboardEditorApi | null) => void;
    onDirty: () => void;
    /** 阅读模式仅允许平移缩放，不修改笔迹。 */
    readOnly?: boolean;
    /** 工具栏占据分栏顶部，画布使用剩余高度，不覆盖笔迹。 */
    registerToolbar?: (toolbar: Snippet | null) => void;
    repair?: ShapeRepair;
  } = $props();
  $effect(() => {
    const register = registerToolbar;
    if (register === undefined) return;
    register(readOnly ? null : editorToolbar);
    return () => register(null);
  });
  let host: HTMLDivElement;
  let input = $state.raw<WhiteboardInput | null>(null);
  let frame = $state(0);
  let error = $state("");
  // 计算错误属于这次落笔，不能被成功的微抖采样或抬笔提交清空。
  let recognitionError = $state("");
  let pointer: number | null = null;
  let space = $state(false);
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  const hintId = $props.id();
  const history = $derived.by(() => {
    void frame;
    return { undo: input?.canUndo ?? false, redo: input?.canRedo ?? false };
  });
  const camera = $derived.by(() => {
    void frame;
    return input?.viewport ?? { x: 0, y: 0, scale: 1 };
  });
  const strokes = $derived.by(() => {
    void frame;
    return input?.displayStrokes ?? [];
  });
  const selected = $derived.by(() => {
    void frame;
    return input?.selection ?? new Set<string>();
  });
  const bounds = $derived.by(() => {
    void frame;
    return input?.selectionBounds ?? null;
  });
  const delta = $derived.by(() => {
    void frame;
    return input?.displacement ?? { x: 0, y: 0 };
  });
  const pending = $derived.by(() => {
    void frame;
    return strokePath(input?.displayPoints ?? []);
  });
  const corrected = $derived.by(() => {
    void frame;
    return input?.corrected ?? false;
  });

  function stopHold(): void {
    clearTimeout(holdTimer);
    holdTimer = undefined;
  }
  function attempt(action: () => void): boolean {
    try {
      action();
      error = "";
      return true;
    } catch (cause) {
      error = `${cause instanceof Error ? cause.message : String(cause)}。按 Esc 可取消本次操作。`;
      return false;
    }
  }
  function point(event: PointerEvent): InkPoint {
    const rect = host.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
      pressure: event.pointerType === "pen" ? event.pressure : 0.5,
    };
  }
  function down(event: PointerEvent): void {
    if (pointer !== null || (event.button !== 0 && event.button !== 1)) return;
    event.preventDefault();
    host.focus({ preventScroll: true });
    const started = attempt(() =>
      input?.begin(
        point(event),
        readOnly || space || event.button === 1 || event.pointerType === "touch",
        event.timeStamp,
      ),
    );
    if (started) {
      recognitionError = "";
      pointer = event.pointerId;
      host.setPointerCapture(event.pointerId);
    }
  }
  function move(event: PointerEvent): void {
    if (event.pointerId !== pointer) return;
    const samples = event.getCoalescedEvents?.() ?? [];
    // 合并事件与父事件择一处理，不能把父事件重复作为额外观测。
    const observed = samples.length > 0 ? samples : [event];
    let restartHold = false;
    const accepted = attempt(() => {
      for (const sample of observed)
        restartHold =
          (input?.update(point(sample), false, sample.timeStamp) ?? false) || restartHold;
    });
    if (!accepted) {
      stopHold();
      return;
    }
    if (restartHold) {
      stopHold();
      const session = input;
      holdTimer = setTimeout(() => {
        if (!session) return;
        recognitionError = "";
        void session.hold().catch((cause: unknown) => {
          if (input === session)
            recognitionError = `图形修复失败，保留原笔迹：${cause instanceof Error ? cause.message : String(cause)}`;
        });
      }, 450);
    }
  }
  function finish(event?: PointerEvent): void {
    if (event && event.pointerId !== pointer) return;
    stopHold();
    attempt(() =>
      input?.finish(
        event?.type === "pointerup" ? point(event) : undefined,
        event?.type === "pointerup" ? event.timeStamp : undefined,
      ),
    );
    const captured = pointer;
    pointer = null;
    if (captured !== null && host.hasPointerCapture(captured)) host.releasePointerCapture(captured);
  }
  function cancel(event: PointerEvent): void {
    if (event.pointerId !== pointer) return;
    stopHold();
    input?.cancel();
    pointer = null;
  }
  function keydown(event: KeyboardEvent): void {
    if (event.isComposing) return;
    if (event.code === "Space" && !(event.ctrlKey || event.metaKey || event.altKey)) {
      event.preventDefault();
      space = true;
    } else if (event.key === "Escape") {
      event.preventDefault();
      stopHold();
      attempt(() => input?.cancel());
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      if (!readOnly) attempt(() => input?.deleteSelection());
    } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      if (!readOnly) attempt(() => input?.selectAll());
    } else if (
      !(event.metaKey || event.ctrlKey || event.altKey) &&
      event.key.toLowerCase() === "f"
    ) {
      event.preventDefault();
      attempt(() => input?.fit(host.clientWidth, host.clientHeight));
    }
  }

  $effect(() => {
    const element = host;
    const initial = board;
    void epoch;
    if (!element) return;
    return untrack(() => {
      const changed = onDirty;
      const session = new WhiteboardInput(
        initial,
        (edited) => {
          frame += 1;
          if (edited) changed();
        },
        repair,
      );
      input = session;
      pointer = null;
      error = "";
      recognitionError = "";
      // 空白板直接使用原始坐标，不能因首个 ResizeObserver 回调迟到而居中新画的笔迹。
      let fitted = initial.strokes.length === 0;
      const resize = new ResizeObserver(() => {
        if (!fitted && element.clientWidth > 0 && element.clientHeight > 0) {
          session.fit(element.clientWidth, element.clientHeight);
          fitted = true;
        }
      });
      resize.observe(element);
      const wheel = (event: WheelEvent) => {
        event.preventDefault();
        const factor =
          event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1;
        attempt(() => {
          if (event.ctrlKey || event.metaKey) {
            const rect = element.getBoundingClientRect();
            session.zoom(
              event.clientX - rect.left,
              event.clientY - rect.top,
              Math.exp(-event.deltaY * factor * 0.005),
            );
          } else session.pan(-event.deltaX * factor, -event.deltaY * factor);
        });
      };
      element.addEventListener("wheel", wheel, { passive: false });
      register({
        focus: () => element.focus({ preventScroll: true }),
        waitForInput: () => session.waitForIdle(),
        finishInput: () => {
          stopHold();
          session.finish();
        },
        snapshot: () => ({
          bytes: new TextEncoder().encode(serializeWhiteboard(session.document)),
          revision: session.revision,
        }),
        history: (action) => {
          if (nativeInputOwnsHistory(element)) return false;
          if (readOnly) return true;
          stopHold();
          attempt(() => session.applyHistory(action));
          return true;
        },
        historyAvailability: () => {
          void frame;
          return nativeInputOwnsHistory(element)
            ? null
            : { undo: !readOnly && session.canUndo, redo: !readOnly && session.canRedo };
        },
      });
      return () => {
        stopHold();
        session.dispose();
        resize.disconnect();
        element.removeEventListener("wheel", wheel);
        register(null);
      };
    });
  });
</script>

{#snippet editorToolbar()}
  {#if !readOnly}
    <div class="board-toolbar" role="toolbar" aria-label="白板编辑工具栏" tabindex="-1">
      <button
        class="reader-button"
        type="button"
        disabled={!history.undo}
        onclick={() => attempt(() => input?.applyHistory("undo"))}>撤销</button
      >
      <button
        class="reader-button"
        type="button"
        disabled={!history.redo}
        onclick={() => attempt(() => input?.applyHistory("redo"))}>重做</button
      >
      <button
        class="reader-button"
        type="button"
        disabled={selected.size === 0}
        onclick={() => attempt(() => input?.deleteSelection())}>删除选中笔迹</button
      >
      <button
        class="reader-button"
        type="button"
        onclick={() => attempt(() => input?.fit(host.clientWidth, host.clientHeight))}
        >查看全部</button
      >
    </div>
  {/if}
{/snippet}
{#if registerToolbar === undefined}{@render editorToolbar()}{/if}

<!-- 图形编辑区需要键盘焦点以支持撤销、选择和移动；Svelte 将 application 归为非交互角色。 -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  class="whiteboard"
  class:panning={space || readOnly}
  bind:this={host}
  role="application"
  tabindex="0"
  aria-label="白板"
  aria-describedby={hintId}
  onpointerdown={down}
  onpointermove={move}
  onpointerup={finish}
  onpointercancel={cancel}
  onlostpointercapture={finish}
  onkeydown={keydown}
  onkeyup={(event) => {
    if (event.code === "Space") space = false;
  }}
  onblur={() => {
    space = false;
    finish();
  }}
  oncontextmenu={(event) => event.preventDefault()}
>
  <svg class="board-canvas" aria-label="白板笔迹" role="img">
    <g transform="translate({camera.x} {camera.y}) scale({camera.scale})">
      {#each strokes as stroke (stroke.id)}
        <path
          data-stroke-id={stroke.id}
          d={strokePath(stroke.points)}
          stroke-width={stroke.width}
          class:selected={selected.has(stroke.id)}
          transform={selected.has(stroke.id) ? `translate(${delta.x} ${delta.y})` : undefined}
        />
      {/each}
      {#if pending}<path class="pending" class:corrected d={pending} stroke-width="2" />{/if}
      {#if bounds}<rect
          class="selection"
          x={bounds.x + delta.x - 5 / camera.scale}
          y={bounds.y + delta.y - 5 / camera.scale}
          width={bounds.width + 10 / camera.scale}
          height={bounds.height + 10 / camera.scale}
          stroke-width={1 / camera.scale}
          stroke-dasharray="{4 / camera.scale} {4 / camera.scale}"
        />{/if}
    </g>
  </svg>
  {#if strokes.length === 0 && !pending}<div class="empty" aria-hidden="true">
      随手写下，慢慢想清楚。
    </div>{/if}
  <div class="hint" id={hintId}>
    {#if !readOnly}<span>写画 · 停笔修复图形 · 来回涂划删除</span>{/if}
    <span>空格拖动 · ⌘ / Ctrl 滚动缩放 · F 查看全部</span>
  </div>
  {#if error || recognitionError}<p class="error" role="alert">{error || recognitionError}</p>{/if}
</div>

<style>
  .board-toolbar {
    display: flex;
    flex-wrap: wrap;
    flex-wrap: wrap;
    gap: 0.3rem;
    padding: 0.5rem;
    background: var(--bg);
    border-bottom: 1px solid var(--border);
  }
  .board-toolbar button {
    font-size: 0.8rem;
    border-color: transparent;
  }
  .whiteboard {
    position: relative;
    flex: 1;
    min-height: 260px;
    overflow: hidden;
    background: var(--bg);
    touch-action: none;
    user-select: none;
    cursor: crosshair;
  }
  .whiteboard:focus {
    outline: none;
  }
  .whiteboard:focus-visible {
    outline: 1px solid var(--accent);
    outline-offset: -1px;
  }
  .panning {
    cursor: grab;
  }
  .board-canvas {
    display: block;
    width: 100%;
    height: 100%;
    position: absolute;
    inset: 0;
    pointer-events: none;
  }
  path {
    stroke: var(--fg);
    fill: none;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  path.selected {
    stroke: var(--accent);
  }
  .selection {
    stroke: var(--accent);
    fill: none;
  }
  .empty {
    position: absolute;
    inset: 42% 1rem auto;
    text-align: center;
    font-size: 1.1rem;
    color: var(--muted);
    pointer-events: none;
  }
  .hint {
    position: absolute;
    inset: auto 1rem 0.8rem;
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 1rem;
    justify-content: space-between;
    font-size: 0.7rem;
    color: var(--muted);
    pointer-events: none;
  }
  .error {
    position: absolute;
    inset: 1rem 1rem auto;
    color: var(--danger);
    background: var(--bg);
    padding: 0.5rem;
    margin: 0;
  }
</style>
