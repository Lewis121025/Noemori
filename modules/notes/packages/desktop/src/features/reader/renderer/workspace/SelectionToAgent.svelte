<script lang="ts">
  import { onDestroy, onMount, untrack } from "svelte";
  import {
    parseSelectedContent,
    SELECTED_CONTENT_MIME,
    type SelectedContent,
  } from "../../shared/selected-content";
  let {
    root,
    path,
    captureSource,
    onAdd,
    host,
  }: {
    root: string;
    path: string;
    captureSource: () => { text: string; offset: number; displayText?: string } | null;
    onAdd: (reference: SelectedContent) => Promise<void>;
    host: HTMLElement;
  } = $props();
  let reference = $state<SelectedContent | null>(null);
  let left = $state(0),
    top = $state(0);
  let adding = $state(false),
    error = $state("");
  let interacting = false;
  let nativeSelectedText = "";
  let sourceIssue = $state(false);
  let frame = 0;
  let generation = 0;
  let live = true;
  onDestroy(() => {
    live = false;
    generation += 1;
    cancelAnimationFrame(frame);
  });
  onMount(() => {
    const clearOnScroll = () => clear();
    const sourceHost = host;
    document.addEventListener("scroll", clearOnScroll, true);
    sourceHost.addEventListener("dragstart", drag);
    return () => {
      document.removeEventListener("scroll", clearOnScroll, true);
      sourceHost.removeEventListener("dragstart", drag);
    };
  });
  $effect(() => {
    void root;
    void path;
    generation += 1;
    cancelAnimationFrame(frame);
    untrack(clear);
  });
  function clear(): void {
    if (!adding) {
      reference = null;
      error = "";
      sourceIssue = false;
      nativeSelectedText = "";
    }
  }
  function measure(): void {
    if (interacting || adding) return;
    const selection = document.getSelection();
    if (
      !selection ||
      selection.isCollapsed ||
      selection.rangeCount !== 1 ||
      !host.contains(selection.anchorNode) ||
      !host.contains(selection.focusNode)
    ) {
      clear();
      return;
    }
    const content = selection.toString();
    if (!content.trim()) {
      clear();
      return;
    }
    let source: { text: string; offset: number; displayText?: string } | null = null;
    sourceIssue = false;
    error = "";
    try {
      source = captureSource();
    } catch (cause) {
      sourceIssue = true;
      error = cause instanceof Error ? cause.message : String(cause);
    }
    const range = selection.getRangeAt(0).getBoundingClientRect();
    if (!range.width && !range.height) {
      clear();
      return;
    }
    nativeSelectedText = content;
    reference = {
      id: crypto.randomUUID(),
      text: source?.displayText ?? content,
      source: { root, path, offset: source?.offset ?? null, sourceText: source?.text ?? content },
    };
    left = Math.max(12, Math.min(range.right - 124, innerWidth - 148));
    top = range.bottom + 8 + 36 < innerHeight ? range.bottom + 8 : Math.max(12, range.top - 42);
  }
  function update(): void {
    const request = ++generation;
    cancelAnimationFrame(frame);
    // 原生 selectionchange 先于编辑器选区事务；两帧后捕获同一份源码位置与可见文字。
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        if (live && request === generation) measure();
      });
    });
  }
  async function add(): Promise<void> {
    const value = reference;
    if (!value || adding || sourceIssue) return;
    adding = true;
    error = "";
    try {
      parseSelectedContent(value);
      await onAdd(value);
      reference = null;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      adding = false;
    }
  }
  function drag(event: DragEvent): void {
    if (!reference || !event.dataTransfer || sourceIssue) return;
    const fromButton = event.currentTarget instanceof HTMLButtonElement;
    if (!fromButton && document.getSelection()?.toString() !== nativeSelectedText) return;
    try {
      parseSelectedContent(reference);
      event.dataTransfer.setData(SELECTED_CONTENT_MIME, JSON.stringify(reference));
      event.dataTransfer.setData("text/plain", reference.text);
      // 正文里的原生拖拽仍可移动文字；Agent 落点明确选择复制，不接管编辑器内部移动。
      event.dataTransfer.effectAllowed = fromButton ? "copy" : "copyMove";
      error = "";
    } catch (cause) {
      event.preventDefault();
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }
  function show(node: HTMLDivElement): void {
    node.showPopover();
  }
</script>

<svelte:document onselectionchange={update} />
<svelte:window
  onresize={clear}
  onscroll={clear}
  onpointerup={() => {
    interacting = false;
    update();
  }}
  ondragend={() => {
    interacting = false;
    clear();
  }}
  onkeydown={(event) => {
    if (event.key === "Escape" && !event.isComposing) clear();
  }}
/>
{#if reference}<div
    class="selection-action"
    popover="manual"
    use:show
    style:left={`${left}px`}
    style:top={`${top}px`}
  >
    <button
      type="button"
      draggable={!adding && !sourceIssue}
      disabled={adding || sourceIssue}
      aria-label="将选中内容添加到 Agent"
      title="添加到当前对话，也可拖入对话输入框"
      onpointerdown={() => {
        interacting = true;
      }}
      ondragstart={drag}
      onclick={() => void add()}
    >
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12" /></svg>{adding
        ? "正在添加…"
        : "添加到 Agent"}
    </button>
    {#if error}<p role="alert">{error}</p>{/if}
  </div>{/if}

<style>
  .selection-action {
    position: fixed;
    inset: auto;
    margin: 0;
    padding: 4px;
    max-width: min(300px, calc(100vw - 24px));
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--surface, var(--bg));
    color: var(--fg);
    box-shadow: var(--shadow-popover, 0 6px 24px #0002);
    animation: appear 120ms ease-out;
  }
  button {
    display: flex;
    align-items: center;
    gap: 5px;
    min-height: 30px;
    padding: 5px 8px;
    border: 0;
    border-radius: 7px;
    color: inherit;
    background: transparent;
    font: inherit;
    font-size: 11px;
    cursor: pointer;
    transition: background 120ms ease;
  }
  button:hover {
    background: var(--selected);
  }
  button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  button:disabled {
    cursor: wait;
    color: var(--muted);
  }
  svg {
    width: 14px;
    height: 14px;
    stroke: currentColor;
    fill: none;
    stroke-width: 1.4;
    stroke-linecap: round;
  }
  p {
    max-width: 260px;
    margin: 5px 8px;
    font-size: 11px;
    color: var(--danger);
    overflow-wrap: anywhere;
  }
  @keyframes appear {
    from {
      opacity: 0;
      transform: translateY(3px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .selection-action {
      animation: none;
    }
    button {
      transition: none;
    }
  }
</style>
