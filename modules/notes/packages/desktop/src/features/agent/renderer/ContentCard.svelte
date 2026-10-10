<script lang="ts">
  import { onDestroy, onMount, untrack } from "svelte";
  import type { AgentApi } from "../shared/api";
  import type { AttachmentUpload } from "../shared/attachments";
  import {
    contentName,
    remoteContentUrl,
    type ContentPreview,
    type ContentSource,
  } from "../shared/content";
  import PreviewContent from "./PreviewContent.svelte";
  import { previewPortal } from "./preview-portal";
  let {
    source,
    api,
    session = "",
    label,
    openLink,
    onInspect,
  }: {
    source: ContentSource;
    api?: AgentApi | undefined;
    session?: string;
    label?: string | undefined;
    openLink?: ((url: string) => Promise<void>) | undefined;
    onInspect?: (() => void) | undefined;
  } = $props();
  let host: HTMLElement;
  let dialog = $state<HTMLDialogElement | null>(null);
  // 文件快照只整体替换；深层代理不能通过 Electron 的结构化克隆边界。
  let preview = $state.raw<ContentPreview | null>(null),
    file = $state.raw<AttachmentUpload | null>(null);
  let loadedName = $state(""),
    loading = $state(false),
    saving = $state(false),
    error = $state("");
  let visible = $state(typeof IntersectionObserver === "undefined"),
    enlarged = $state(false);
  let version = 0,
    live = true;
  const identity = $derived(
    source.type === "inline"
      ? source.file
      : source.type === "attachment"
        ? source.id
        : source.reference,
  );
  const name = $derived(
    label ||
      loadedName ||
      (source.type === "reference"
        ? contentName(source.reference)
        : source.type === "attachment"
          ? source.name
          : source.file.name),
  );
  const remote = $derived(source.type === "reference" ? remoteContentUrl(source.reference) : null);
  onMount(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          visible = true;
          observer.disconnect();
        }
      },
      { rootMargin: "120px" },
    );
    observer.observe(host);
    return () => observer.disconnect();
  });
  onDestroy(() => {
    live = false;
    version++;
  });
  $effect(() => {
    void identity;
    void session;
    void visible;
    untrack(() => {
      version++;
      preview = null;
      file = null;
      loadedName = "";
      error = "";
      loading = false;
      saving = false;
      if (source.type === "inline") {
        preview = source.preview;
        file = source.file;
      } else if (visible && !remote) void load();
    });
  });
  async function load(): Promise<void> {
    if (loading || source.type === "inline") return;
    const request = ++version,
      owner = session,
      selected = source;
    loading = true;
    error = "";
    preview = null;
    try {
      if (selected.type === "attachment") {
        if (!api) throw new Error("附件预览暂不可用");
        const result = await api.attachmentPreview(owner, selected.id);
        if (live && request === version && owner === session) preview = result;
      } else if (api) {
        const result = await api.contentPreview(owner, selected.reference);
        if (live && request === version && owner === session) {
          preview = result.preview;
          file = { name: result.name, bytes: result.bytes };
          loadedName = result.name;
        }
      } else if (remote && /\.(?:png|jpe?g|gif|webp|svg|avif|bmp)(?:[?#]|$)/iu.test(remote))
        preview = { type: "image", url: remote };
      else throw new Error("文件预览暂不可用");
    } catch (cause) {
      if (live && request === version && owner === session)
        error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      if (live && request === version && owner === session) loading = false;
    }
  }
  async function save(): Promise<void> {
    if (!api || saving) return;
    const owner = session,
      request = version,
      selected = source,
      snapshot = file;
    saving = true;
    error = "";
    try {
      if (selected.type === "attachment") await api.attachmentSave(owner, selected.id);
      else if (snapshot)
        await api.contentSave({ name: snapshot.name, bytes: new Uint8Array(snapshot.bytes) });
    } catch (cause) {
      if (live && request === version && owner === session)
        error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      if (live && request === version && owner === session) saving = false;
    }
  }
  function closeEnlarged(): void {
    if (!enlarged || !dialog) return;
    host.style.removeProperty("height");
    dialog.close();
    enlarged = false;
  }
  function enlarge(): void {
    if (!dialog) return;
    onInspect?.();
    if (enlarged) {
      closeEnlarged();
      return;
    }
    // 移动同一预览视图，避免重新解析 PDF 或丢失当前页码、缩放和播放位置。
    host.style.height = `${host.getBoundingClientRect().height}px`;
    try {
      dialog.showModal();
      enlarged = true;
    } catch (cause) {
      host.style.removeProperty("height");
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }
  async function external(): Promise<void> {
    try {
      if (remote && openLink) await openLink(remote);
      else if (source.type === "attachment" && api) await api.attachmentOpen(session, source.id);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }
</script>

<section class="content-card" aria-label={`内容：${name}`} bind:this={host}>
  <div class="content-panel" use:previewPortal={enlarged ? dialog : null}>
    <header>
      <svg class="file-icon" viewBox="0 0 20 20" aria-hidden="true"
        ><path d="M5 2.5h6l4 4v11H5ZM11 2.5v4h4M8 10h4m-4 3h4" /></svg
      ><span title={name}>{name}</span>
      <div class="content-actions">
        {#if source.type !== "inline"}<button
            type="button"
            disabled={loading}
            aria-label="重新加载内容"
            title="重新加载内容"
            onclick={() => {
              onInspect?.();
              void load();
            }}
            ><svg viewBox="0 0 20 20" aria-hidden="true"
              ><path d="M16 8a6 6 0 1 0 0 5M16 3v5h-5" /></svg
            ></button
          >{/if}
        {#if preview && preview.type !== "file"}<button
            type="button"
            aria-label={enlarged ? "关闭放大预览" : "放大内容预览"}
            title={enlarged ? "关闭放大预览" : "放大预览"}
            onclick={() => void enlarge()}
            ><svg viewBox="0 0 20 20" aria-hidden="true"
              >{#if enlarged}<path d="m5 5 10 10M15 5 5 15" />{:else}<path
                  d="M3 7V3h4m6 0h4v4m0 6v4h-4m-6 0H3v-4"
                />{/if}</svg
            ></button
          >{/if}
        {#if api && (file || source.type === "attachment")}<button
            type="button"
            disabled={saving}
            aria-label="保存文件"
            title="保存文件"
            onclick={() => void save()}
            ><svg viewBox="0 0 20 20" aria-hidden="true"
              ><path d="M10 3v10m-4-4 4 4 4-4M4 14v3h12v-3" /></svg
            ></button
          >{/if}
        {#if (remote && openLink) || (source.type === "attachment" && api)}<button
            type="button"
            aria-label="打开原文件"
            title="打开原文件"
            onclick={() => void external()}
            ><svg viewBox="0 0 20 20" aria-hidden="true"
              ><path d="M11 3h6v6m0-6-9 9M8 4H4v12h12v-4" /></svg
            ></button
          >{/if}
      </div>
    </header>
    <div class="content-stage">
      {#if preview}<PreviewContent {preview} {name} {onInspect} />
      {:else if loading}<p role="status">正在加载…</p>
      {:else if !error}<button
          class="load-content"
          type="button"
          onclick={() => {
            onInspect?.();
            void load();
          }}>查看内容</button
        >{/if}
      {#if error}<div class="content-error" role="alert">
          <span>{error}</span><button type="button" onclick={() => void load()}>重试</button>
        </div>{/if}
    </div>
  </div>
</section>
<dialog
  class="content-dialog"
  aria-label={`内容预览：${name}`}
  bind:this={dialog}
  oncancel={(event) => {
    event.preventDefault();
    closeEnlarged();
  }}
></dialog>

<style>
  .content-card {
    margin: 12px 0;
    min-width: 0;
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
    background: var(--surface);
    color: var(--fg);
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px 6px 12px;
    font-size: 12px;
    border-bottom: 1px solid var(--border);
  }
  header > span {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  svg {
    width: 15px;
    height: 15px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
    flex-shrink: 0;
  }
  .file-icon {
    color: var(--muted);
  }
  .content-actions {
    display: flex;
    gap: 2px;
  }
  button {
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--muted);
    font: inherit;
    cursor: pointer;
  }
  .content-actions button {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    padding: 0;
  }
  button:hover:not(:disabled) {
    background: var(--control-hover, var(--selected));
    color: var(--fg);
  }
  button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .content-stage {
    min-width: 0;
    min-height: 0;
  }
  /* 文件卡片负责整体放大，内嵌 HTML 不再重复提供放大入口。 */
  .content-panel :global(.preview-tools [data-expand-preview]) {
    display: none;
  }
  p,
  .content-error {
    margin: 0;
    padding: 16px 12px;
    font-size: 12px;
    line-height: 1.6;
  }
  p {
    color: var(--muted);
  }
  .load-content {
    display: block;
    margin: 12px;
    padding: 7px 10px;
    background: var(--bg);
    font-size: 12px;
  }
  .content-error {
    color: var(--danger);
    overflow-wrap: anywhere;
  }
  .content-error button {
    margin-left: 8px;
    padding: 4px 6px;
    background: var(--bg);
  }
  .content-dialog {
    width: calc(100vw - 32px);
    height: calc(100dvh - 32px);
    max-width: 1100px;
    max-height: 860px;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 14px;
    background: var(--surface);
    color: var(--fg);
    box-shadow: var(--shadow-popover);
  }
  .content-dialog::backdrop {
    background: var(--scrim, #0005);
  }
  .content-dialog :global(.content-panel) {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .content-dialog :global(.content-stage) {
    flex: 1;
    overflow: auto;
  }
  .content-dialog :global(.preview-surface),
  .content-dialog :global(.attachment-preview),
  .content-dialog :global(.attachment-preview.compact) {
    height: 100%;
  }
  .content-dialog :global(.html-content),
  .content-dialog :global(.preview-frame),
  .content-dialog :global(.preview-body) {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  .content-dialog :global(iframe) {
    flex: 1;
    min-height: 0;
    height: auto;
  }
</style>
