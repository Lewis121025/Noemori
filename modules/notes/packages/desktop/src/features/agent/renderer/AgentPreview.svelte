<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import { on } from "svelte/events";
  import type { AgentApi, BrowserHumanInput, UiPreviewTarget } from "../shared/api";
  import { parsePreviewTarget, previewPosition } from "../shared/preview";

  let {
    api,
    session,
    target,
    title,
    human = false,
    dialog = null,
    fileChooser = false,
    close,
  }: {
    api: AgentApi;
    session: string;
    target: UiPreviewTarget;
    title: string;
    human?: boolean;
    dialog?: { type: string; message: string } | null;
    fileChooser?: boolean;
    close: () => void;
  } = $props();
  let frame = $state("");
  let previewError = $state("");
  let inputError = $state("");
  let inputToken = $state<string | null>(null);
  let surface = $state<HTMLElement>();
  let picture = $state<HTMLImageElement>();
  let textField = $state<HTMLInputElement>();
  let x = $state(0),
    y = $state(0);
  let expanded = $state(false),
    showInput = $state(false);
  let restoreBounds: { x: number; y: number; width: number; height: number } | null = null;
  let typing = $state("");
  let dialogText = $state("");
  let inputQueue: Promise<void> = Promise.resolve();
  let inputEpoch = 0;
  let disposed = false;
  let drag: { pointer: number; x: number; y: number; left: number; top: number } | null = null;
  const identity = $derived(JSON.stringify(target));
  const interactive = $derived(human && target.backend === "managed" && inputToken !== null);
  const error = $derived(inputError || previewError);
  onDestroy(() => {
    disposed = true;
    inputEpoch++;
  });

  function place(): void {
    if (!surface) return;
    const next = previewPosition(
      x,
      y,
      surface.offsetWidth,
      surface.offsetHeight,
      window.innerWidth,
      window.innerHeight,
    );
    x = next.x;
    y = next.y;
  }
  function toggleSize(): void {
    if (!surface) return;
    if (!expanded)
      restoreBounds = { x, y, width: surface.offsetWidth, height: surface.offsetHeight };
    surface.style.width = `${expanded ? (restoreBounds?.width ?? 576) : 1000}px`;
    surface.style.height = `${expanded ? (restoreBounds?.height ?? 360) : 720}px`;
    if (expanded && restoreBounds) {
      x = restoreBounds.x;
      y = restoreBounds.y;
    }
    expanded = !expanded;
    place();
  }
  function portal(node: HTMLElement) {
    document.body.append(node);
    x = Math.max(8, window.innerWidth - node.offsetWidth - 24);
    y = 72;
    place();
    const resize = new ResizeObserver(place);
    resize.observe(node);
    window.addEventListener("resize", place);
    return {
      destroy() {
        resize.disconnect();
        window.removeEventListener("resize", place);
        node.remove();
      },
    };
  }
  $effect(() => {
    const owner = session,
      selected = parsePreviewTarget(JSON.parse(identity));
    let ended = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    frame = "";
    previewError = "";
    inputError = "";
    inputToken = null;
    inputEpoch++;
    if (human && (selected.backend === "chrome" || selected.backend === "edge")) {
      previewError = "浏览器已交给你操作，交还助手后恢复预览";
      return;
    }
    async function refresh(): Promise<void> {
      try {
        const result = await api.uiPreview(owner, selected);
        if (!ended) {
          if (result.image !== null) frame = result.image;
          inputToken = result.inputToken;
          previewError = "";
        }
      } catch (reason) {
        if (!ended) {
          inputToken = null;
          previewError = reason instanceof Error ? reason.message : String(reason);
        }
      } finally {
        if (!ended) timer = setTimeout(() => void refresh(), 1000);
      }
    }
    void refresh();
    return () => {
      ended = true;
      inputEpoch++;
      clearTimeout(timer);
    };
  });
  function pointerDown(event: PointerEvent): void {
    if (event.currentTarget instanceof HTMLElement)
      event.currentTarget.setPointerCapture(event.pointerId);
    drag = { pointer: event.pointerId, x: event.clientX, y: event.clientY, left: x, top: y };
  }
  function pointerMove(event: PointerEvent): void {
    if (!drag || drag.pointer !== event.pointerId) return;
    x = drag.left + event.clientX - drag.x;
    y = drag.top + event.clientY - drag.y;
    place();
  }
  function input(value: BrowserHumanInput): void {
    if (!interactive || target.backend !== "managed" || inputToken === null) return;
    const page = target.page,
      owner = session,
      token = inputToken,
      epoch = inputEpoch;
    inputError = "";
    inputQueue = inputQueue
      .then(async () => {
        if (disposed || epoch !== inputEpoch || !human || session !== owner || inputToken !== token)
          return;
        await api.browserInput(owner, page, token, value);
      })
      .catch((reason: unknown) => {
        if (disposed || epoch !== inputEpoch) return;
        inputEpoch++;
        inputError = reason instanceof Error ? reason.message : String(reason);
      });
  }
  function click(event: MouseEvent): void {
    if (!picture) return;
    const bounds = picture.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    input({
      type: "pointer",
      x: Math.floor(((event.clientX - bounds.left) * picture.naturalWidth) / bounds.width),
      y: Math.floor(((event.clientY - bounds.top) * picture.naturalHeight) / bounds.height),
    });
  }
  function browserEvents(node: HTMLElement) {
    const removeKey = on(node, "keydown", key);
    const remove = on(
      node,
      "wheel",
      (event) => {
        if (!interactive) return;
        event.preventDefault();
        event.stopPropagation();
        input({
          type: "scroll",
          x: Math.max(-10000, Math.min(10000, event.deltaX)),
          y: Math.max(-10000, Math.min(10000, event.deltaY)),
        });
      },
      { passive: false },
    );
    return {
      destroy() {
        removeKey();
        remove();
      },
    };
  }
  function key(event: KeyboardEvent): void {
    if (!interactive || event.isComposing) return;
    event.stopPropagation();
    if (["Shift", "Control", "Meta", "Alt"].includes(event.key)) return;
    event.preventDefault();
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      input({ type: "text", text: event.key });
      return;
    }
    const modifiers = [
      event.ctrlKey ? "Control" : "",
      event.metaKey ? "Meta" : "",
      event.altKey ? "Alt" : "",
      event.shiftKey ? "Shift" : "",
    ].filter(Boolean);
    input({ type: "key", key: [...modifiers, event.key].join("+") });
  }
  async function toggleInput(): Promise<void> {
    showInput = !showInput;
    if (showInput) {
      await tick();
      textField?.focus();
    }
  }
  async function chooseFiles(): Promise<void> {
    if (target.backend !== "managed" || inputToken === null) return;
    const epoch = inputEpoch;
    inputError = "";
    try {
      await api.browserChooseFiles(session, target.page, inputToken);
    } catch (reason) {
      if (!disposed && epoch === inputEpoch)
        inputError = reason instanceof Error ? reason.message : String(reason);
    }
  }
</script>

<div
  use:portal
  bind:this={surface}
  class="agent-preview"
  class:expanded
  style:left="{x}px"
  style:top="{y}px"
  role="dialog"
  aria-label={title}
  tabindex="-1"
>
  <div class="screen">
    {#if frame}
      <button
        class="image"
        class:interactive
        aria-label="浏览器画面"
        disabled={!interactive}
        onclick={click}
        use:browserEvents
        ><img bind:this={picture} src={frame} alt={title} draggable="false" /></button
      >
    {:else}<p class="placeholder">
        {error ? "画面暂不可用" : dialog ? "请处理网页对话框" : "正在连接画面…"}
      </p>{/if}
  </div>
  {#if human && target.backend === "managed" && dialog}
    <div class="page-dialog">
      <p>{dialog.message}</p>
      {#if dialog.type === "prompt"}<input
          aria-label="网页对话框输入"
          bind:value={dialogText}
          maxlength="16384"
        />{/if}
      <div class="dialog-actions">
        <button
          disabled={!interactive}
          onclick={() => {
            input({ type: "dialog", accept: false });
            dialogText = "";
          }}>取消</button
        ><button
          disabled={!interactive}
          onclick={() => {
            input({ type: "dialog", accept: true, text: dialogText });
            dialogText = "";
          }}>确定</button
        >
      </div>
    </div>
  {/if}
  {#if human && target.backend === "managed" && fileChooser}<button
      class="file-choice"
      disabled={!interactive}
      onclick={() => void chooseFiles()}>选择工作区文件…</button
    >{/if}
  {#if human && target.backend === "managed" && showInput}
    <form
      onsubmit={(event) => {
        event.preventDefault();
        if (typing && interactive) {
          input({ type: "text", text: typing });
          typing = "";
        }
      }}
    >
      <input
        bind:this={textField}
        aria-label="向浏览器输入文字"
        bind:value={typing}
        maxlength="16384"
        placeholder="输入文字…"
        disabled={!interactive}
      />
      <button
        class="icon-button"
        type="submit"
        aria-label="发送文字"
        disabled={!typing || !interactive}
        ><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 15V5m-4 4 4-4 4 4" /></svg
        ></button
      >
    </form>
  {/if}
  {#if error}<p class="error" role="status">{error}</p>{/if}
  <footer aria-label="画面操作">
    <button
      class="drag"
      aria-label="拖动画面窗口"
      onpointerdown={pointerDown}
      onpointermove={pointerMove}
      onpointerup={() => {
        drag = null;
      }}
      onpointercancel={() => {
        drag = null;
      }}
      onkeydown={(event) => {
        const offsets: Record<string, [number, number]> = {
          ArrowLeft: [-20, 0],
          ArrowRight: [20, 0],
          ArrowUp: [0, -20],
          ArrowDown: [0, 20],
        };
        const offset = offsets[event.key];
        if (offset) {
          event.preventDefault();
          x += offset[0];
          y += offset[1];
          place();
        }
      }}
    >
      <svg viewBox="0 0 20 20" aria-hidden="true"
        ><path d="M7 5h.1M13 5h.1M7 10h.1M13 10h.1M7 15h.1M13 15h.1" /></svg
      >
    </button>
    {#if human && target.backend === "managed"}
      <button
        class="icon-button"
        class:active={showInput}
        aria-label="输入文字"
        title="输入文字"
        aria-expanded={showInput}
        onclick={() => void toggleInput()}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true"
          ><rect x="2.5" y="5" width="15" height="10" rx="2" /><path
            d="M5 8h.1M8 8h.1M11 8h.1M14 8h.1M5 10.5h.1M8 10.5h.1M11 10.5h.1M14 10.5h.1M6.5 13h7"
          /></svg
        >
      </button>
    {/if}
    <button
      class="icon-button"
      aria-label={expanded ? "恢复画面大小" : "放大画面"}
      title={expanded ? "恢复大小" : "放大画面"}
      onclick={toggleSize}
    >
      <svg viewBox="0 0 20 20" aria-hidden="true"
        ><path d={expanded ? "M3 8h5V3m9 9h-5v5" : "M3 8V3h5m9 9v5h-5"} /></svg
      >
    </button>
    <button class="icon-button close" aria-label="关闭画面" title="关闭画面" onclick={close}
      ><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 6 8 8m0-8-8 8" /></svg></button
    >
  </footer>
  {#if !expanded}<span class="resize-corner" aria-hidden="true"></span>{/if}
</div>

<style>
  .agent-preview {
    position: fixed;
    z-index: 1100;
    display: flex;
    flex-direction: column;
    width: 576px;
    height: 360px;
    min-width: min(320px, calc(100vw - 16px));
    min-height: min(220px, calc(100vh - 16px));
    max-width: calc(100vw - 16px);
    max-height: calc(100vh - 16px);
    resize: both;
    overflow: hidden;
    padding: 0;
    border: 0;
    border-radius: 18px;
    background:
      linear-gradient(150deg, light-dark(#ffffff66, #ffffff12), transparent 55%),
      light-dark(#ffffff70, #25293185);
    color: light-dark(#40444b, #d8dbe1);
    box-shadow:
      inset 0 1px 0 light-dark(#ffffffcc, #ffffff24),
      inset 0 -1px 0 light-dark(#1020300a, #00000022),
      0 16px 48px light-dark(#17202d26, #00000066),
      0 3px 10px light-dark(#17202d0a, #00000022);
    backdrop-filter: blur(28px) saturate(160%);
    font-family: inherit;
    -webkit-app-region: no-drag;
  }
  .expanded {
    resize: none;
  }
  footer {
    position: absolute;
    top: 12px;
    right: 12px;
    display: flex;
    align-items: center;
    gap: 2px;
    height: 30px;
    max-width: 100%;
    padding: 3px;
    border-radius: 10px;
    background: light-dark(#ffffff99, #292d3499);
    box-shadow:
      inset 0 1px 0 light-dark(#ffffffb3, #ffffff24),
      0 2px 8px light-dark(#11182712, #00000030);
    backdrop-filter: blur(18px) saturate(160%);
    opacity: 0;
    pointer-events: none;
    transition: opacity 120ms ease;
  }
  .agent-preview:hover footer,
  .agent-preview:focus-within footer,
  .agent-preview:hover .resize-corner,
  .agent-preview:focus-within .resize-corner {
    opacity: 1;
  }
  .agent-preview:hover footer,
  .agent-preview:focus-within footer {
    pointer-events: auto;
  }
  button {
    color: inherit;
    font: inherit;
    border: 0;
    background: transparent;
    cursor: pointer;
  }
  button:disabled {
    cursor: default;
    opacity: 0.5;
  }
  button:focus-visible {
    outline: 2px solid light-dark(#728ba4, #9db5cd);
    outline-offset: -2px;
  }
  svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.25;
    stroke-linecap: round;
    stroke-linejoin: round;
    flex-shrink: 0;
  }
  .drag {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    cursor: grab;
    text-align: left;
    touch-action: none;
    border-radius: 7px;
    opacity: 0.6;
  }
  .icon-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    flex-shrink: 0;
    padding: 0;
    border-radius: 7px;
    opacity: 0.6;
  }
  .icon-button:hover,
  .icon-button.active,
  .drag:hover {
    opacity: 1;
    background: light-dark(#eceef1, #ffffff0e);
  }
  .close:hover {
    background: #b7564814;
    color: #ab584c;
  }
  .screen {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 1;
    min-height: 0;
    overflow: hidden;
    border-radius: inherit;
    background: transparent;
  }
  .image {
    display: contents;
    cursor: default;
  }
  .image:disabled {
    opacity: 1;
  }
  .interactive {
    cursor: default;
  }
  img {
    display: block;
    max-width: 100%;
    max-height: 100%;
    width: auto;
    height: auto;
    user-select: none;
  }
  .image:focus-visible img {
    outline: 2px solid light-dark(#728ba4, #9db5cd);
    outline-offset: -2px;
  }
  .placeholder {
    margin: 0;
    font-size: 12px;
    opacity: 0.5;
  }
  form {
    display: flex;
    gap: 6px;
    flex-shrink: 0;
    margin-top: 6px;
    padding: 5px 7px;
    border: 0;
    border-radius: 9px;
    background: light-dark(#ffffff80, #292c3180);
  }
  input {
    flex: 1;
    min-width: 0;
    padding: 4px 7px;
    border: 0;
    border-radius: 5px;
    font: inherit;
    font-size: 12px;
    background: transparent;
    color: inherit;
    outline: none;
  }
  input:focus-visible {
    box-shadow: inset 0 0 0 1px light-dark(#728ba460, #9db5cd60);
  }
  input::placeholder {
    color: inherit;
    opacity: 0.4;
  }
  .page-dialog {
    max-height: 45%;
    overflow: auto;
    flex-shrink: 0;
    margin-top: 6px;
    padding: 10px 14px;
    border: 0;
    border-radius: 9px;
    font-size: 12px;
  }
  .page-dialog p {
    margin: 0 0 8px;
    line-height: 1.5;
  }
  .dialog-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  .dialog-actions button,
  .file-choice {
    padding: 6px 10px;
    border-radius: 6px;
    font-size: 12px;
  }
  .dialog-actions button:last-child {
    background: light-dark(#eceef1, #ffffff12);
  }
  .error {
    max-height: 48px;
    overflow: auto;
    color: light-dark(#985347, #e7a294);
    margin: 0;
    padding: 7px 12px;
    font-size: 11px;
    line-height: 1.4;
    overflow-wrap: anywhere;
  }
  .resize-corner {
    position: absolute;
    right: 4px;
    bottom: 4px;
    width: 6px;
    height: 6px;
    border-right: 1px solid light-dark(#8e949b60, #b8bfc760);
    border-bottom: 1px solid light-dark(#8e949b60, #b8bfc760);
    border-bottom-right-radius: 2px;
    opacity: 0;
    pointer-events: none;
  }
  .agent-preview::-webkit-resizer {
    background: transparent;
  }
  @media (hover: none) {
    footer {
      opacity: 1;
      pointer-events: auto;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    footer {
      transition: none;
    }
  }
</style>
