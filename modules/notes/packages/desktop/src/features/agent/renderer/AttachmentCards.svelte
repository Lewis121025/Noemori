<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import type { AgentApi } from "../shared/api";
  import type { AgentAttachment, AttachmentPreview } from "../shared/attachments";
  let {
    api,
    session,
    files,
    disabled = false,
    onRemove,
  }: {
    api: AgentApi;
    session: string;
    files: AgentAttachment[];
    disabled?: boolean;
    onRemove?: (id: string) => void;
  } = $props();
  let selected = $state<AgentAttachment | null>(null);
  let preview = $state<AttachmentPreview | null>(null);
  let loading = $state(false);
  let opening = $state(false);
  let error = $state("");
  let dialog: HTMLDialogElement;
  let version = 0;
  let live = true;
  onDestroy(() => {
    live = false;
    version += 1;
  });
  const size = (bytes: number) =>
    bytes < 1024
      ? `${bytes} B`
      : bytes < 1024 * 1024
        ? `${Math.ceil(bytes / 1024)} KB`
        : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

  async function show(file: AgentAttachment): Promise<void> {
    const request = ++version,
      owner = session;
    selected = file;
    preview = null;
    error = "";
    loading = true;
    opening = false;
    await tick();
    if (!live || request !== version || session !== owner) return;
    dialog.showModal();
    try {
      const value = await api.attachmentPreview(owner, file.id);
      if (live && request === version && session === owner) preview = value;
    } catch (cause) {
      if (live && request === version && session === owner)
        error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      if (live && request === version && session === owner) loading = false;
    }
  }
  function reset(): void {
    version += 1;
    selected = null;
    preview = null;
    loading = false;
    opening = false;
    error = "";
  }
  async function open(): Promise<void> {
    if (!selected || opening) return;
    const file = selected,
      owner = session,
      request = version;
    opening = true;
    error = "";
    try {
      await api.attachmentOpen(owner, file.id);
    } catch (cause) {
      if (live && request === version && session === owner)
        error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      if (live && request === version && session === owner) opening = false;
    }
  }
</script>

{#if files.length}<ul class="attachments" aria-label={onRemove ? "消息附件" : "已发送附件"}>
    {#each files as file (file.id)}<li>
        <button
          class="file"
          type="button"
          aria-label={`预览附件：${file.name}`}
          title={file.name}
          onclick={() => void show(file)}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            {#if file.image}<rect x="3" y="3" width="14" height="14" rx="2" /><circle
                cx="7"
                cy="7"
                r="1"
              /><path d="m4 15 4-4 3 3 3-5 3 6" />
            {:else}<path d="M5 3h7l3 3v11H5zM12 3v4h3M8 10h4M8 13h4" />{/if}
          </svg>
          <span><strong>{file.name}</strong><span class="size">{size(file.size)}</span></span>
        </button>
        {#if onRemove}<button
            class="remove"
            type="button"
            aria-label={`移除附件：${file.name}`}
            title="移除附件"
            {disabled}
            onclick={() => onRemove?.(file.id)}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 6 8 8M14 6l-8 8" /></svg>
          </button>{/if}
      </li>{/each}
  </ul>{/if}
<dialog bind:this={dialog} aria-label="附件预览" onclose={reset}>
  {#if selected}<header>
      <div>
        <h2>{selected.name}</h2>
        <p>{size(selected.size)}</p>
      </div>
      <button type="button" aria-label="关闭附件预览" onclick={() => dialog.close()}>×</button>
    </header>
    {#if loading}<p role="status">正在读取附件…</p>
    {:else if preview?.type === "image"}<img src={preview.url} alt={selected.name} />
    {:else if preview?.type === "text"}<pre>{preview.text || "文件为空"}</pre>
      {#if preview.truncated}<p>预览显示前 128 KB，Agent 仍可读取完整文件。</p>{/if}
    {:else if preview?.type === "file"}<p>可在系统应用中查看这个文件。</p>{/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <footer>
      <button type="button" disabled={opening || loading} onclick={() => void open()}
        >{opening ? "正在打开…" : "在系统中打开"}</button
      ><button type="button" onclick={() => dialog.close()}>关闭</button>
    </footer>
  {/if}
</dialog>

<style>
  .attachments {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 0 0 10px;
    padding: 0;
    list-style: none;
    max-height: 126px;
    overflow-y: auto;
  }
  li {
    display: flex;
    align-items: center;
    min-width: 0;
    max-width: 100%;
    flex: 0 1 168px;
    border: 1px solid var(--border);
    border-radius: var(--radius-control, 8px);
    background: var(--bg);
    animation: attachment-enter var(--motion-enter, 140ms) var(--motion-ease, ease-out);
  }
  button {
    color: inherit;
    font: inherit;
    border: 0;
    background: transparent;
    border-radius: 7px;
    cursor: pointer;
  }
  button:hover:not(:disabled) {
    background: var(--control-hover, var(--selected));
  }
  button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .file {
    display: flex;
    align-items: center;
    gap: 7px;
    flex: 1;
    min-width: 0;
    padding: 7px 8px;
    text-align: left;
  }
  .file > span {
    flex: 1;
    min-width: 0;
  }
  strong,
  .size {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  strong {
    font-size: 11px;
    font-weight: 550;
  }
  .size {
    font-size: 10px;
    color: var(--muted);
    margin-top: 3px;
  }
  svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
    flex-shrink: 0;
    color: var(--muted);
  }
  .remove {
    width: 24px;
    height: 26px;
    padding: 4px;
    margin-right: 3px;
  }
  dialog {
    width: min(560px, calc(100vw - 32px));
    max-height: calc(100dvh - 32px);
    box-sizing: border-box;
    padding: 18px;
    border: 1px solid var(--border);
    border-radius: var(--radius-panel, 14px);
    background: var(--surface);
    color: var(--fg);
    box-shadow: var(--shadow-popover);
  }
  dialog::backdrop {
    background: var(--scrim, #0005);
  }
  header {
    display: flex;
    gap: 12px;
    align-items: start;
  }
  header div {
    flex: 1;
    min-width: 0;
  }
  header button {
    width: 28px;
    height: 28px;
    font-size: 22px;
  }
  h2 {
    margin: 0;
    font-size: 14px;
    font-weight: 550;
    overflow-wrap: anywhere;
  }
  p {
    color: var(--muted);
    font-size: 12px;
    line-height: 1.7;
    overflow-wrap: anywhere;
  }
  img {
    display: block;
    margin: 16px auto;
    max-width: 100%;
    max-height: 60dvh;
    object-fit: contain;
  }
  pre {
    max-height: 55dvh;
    overflow: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-size: 12px;
    line-height: 1.7;
    user-select: text;
  }
  footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  footer button {
    padding: 7px 10px;
    font-size: 12px;
  }
  .error {
    color: var(--danger);
  }
  @keyframes attachment-enter {
    from {
      opacity: 0;
      translate: 0 3px;
    }
    to {
      opacity: 1;
      translate: 0 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    li {
      animation: none;
    }
  }
</style>
