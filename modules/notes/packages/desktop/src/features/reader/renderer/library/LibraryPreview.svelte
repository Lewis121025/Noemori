<script lang="ts">
  import { tick, untrack } from "svelte";
  import type { VaultEntry } from "../../shared/api";
  import type {
    ArticleAgentActions,
    ArticleConversationPreview,
  } from "../../shared/article-conversations";
  import type { ReaderWorkspaceController } from "../workspace/state.svelte";
  import type { OpenContentLink } from "../editor/links/link-interaction";
  import { readFileContent, type FileContent } from "../document/file-content";
  import { libraryEntryKind } from "./library";
  import { libraryTitle } from "./library-tree";
  import ImagePreview from "../preview/ImagePreview.svelte";
  import PdfPreview from "../preview/PdfPreview.svelte";
  import WhiteboardPreview from "../whiteboard/WhiteboardPreview.svelte";
  import LibraryDocument from "./LibraryDocument.svelte";

  let {
    entry,
    workspace,
    readFile,
    onOpen,
    busy,
    query,
    articleAgent,
    tab = $bindable("article"),
    focused,
    onFocus,
    onFollowLink,
  }: {
    entry: VaultEntry | null;
    workspace: ReaderWorkspaceController;
    readFile: (path: string) => Promise<Uint8Array>;
    onOpen: (entry: VaultEntry) => void;
    busy: boolean;
    query: string;
    articleAgent?: ArticleAgentActions;
    tab?: "article" | "chat";
    focused: boolean;
    onFocus: () => void;
    onFollowLink: OpenContentLink;
  } = $props();
  const root = $derived(workspace.vaultRoot);
  let content = $state.raw<FileContent | null>(null);
  let error = $state(""),
    loading = $state(false);
  let documentView: LibraryDocument | undefined = $state();
  let matchState = $state({ count: 0, current: 0 });
  let conversations = $state<Omit<ArticleConversationPreview, "excerpt" | "messages">[]>([]);
  let selectedId = $state<string | null>(null);
  let conversation = $state.raw<ArticleConversationPreview | null>(null);
  let conversationError = $state(""),
    listError = $state(""),
    opening = $state(false);
  let infoButton: HTMLButtonElement, infoPanel: HTMLDivElement;
  const id = $props.id();
  const markdown = $derived(entry?.kind === "file" && /\.md$/iu.test(entry.path));
  const descendants = $derived(
    entry?.kind === "directory"
      ? workspace.entries.filter((item) => item.path.startsWith(`${entry.path}/`))
      : [],
  );

  $effect(() => {
    const selected = entry,
      vault = root;
    void workspace.indexRevision;
    content = null;
    error = "";
    loading = selected?.kind === "file";
    matchState = { count: 0, current: 0 };
    let live = true;
    if (selected?.kind === "file" && vault)
      void readFile(selected.path)
        .then((bytes) => {
          if (live) content = readFileContent(selected.path, bytes);
        })
        .catch((cause: unknown) => {
          if (live) error = String(cause);
        })
        .finally(() => {
          if (live) loading = false;
        });
    return () => {
      live = false;
    };
  });
  $effect(() => {
    const path = entry?.path,
      vault = root,
      bridge = articleAgent;
    selectedId = null;
    conversations = [];
    listError = "";
    if (!bridge || !vault || !path || !markdown) return;
    let live = true,
      generation = 0;
    const refresh = async () => {
      const current = ++generation;
      try {
        await bridge.api.attachVault(vault);
        const result = await bridge.api.list();
        if (!live || current !== generation) return;
        conversations = result.items.filter(
          (item) => item.workspace === vault && item.article?.path === path && !item.archived,
        );
        if (selectedId === null) selectedId = conversations[0]?.id ?? null;
        listError = "";
      } catch (cause) {
        if (live && current === generation) listError = String(cause);
      }
    };
    void untrack(refresh);
    const stop = bridge.api.subscribe(() => {
      void refresh();
    });
    return () => {
      live = false;
      stop();
    };
  });
  $effect(() => {
    const selected = selectedId,
      bridge = articleAgent,
      vault = root,
      path = entry?.path;
    conversation = null;
    conversationError = "";
    if (!selected || !bridge || !vault || !path) return;
    let live = true,
      generation = 0;
    const refresh = async () => {
      const current = ++generation;
      try {
        const item = await bridge.api.snapshot(selected);
        if (!live || current !== generation) return;
        if (item.workspace !== vault || item.article?.path !== path)
          throw new Error("对话已不属于此文章，请在 Agent 中查看。");
        conversation = item;
        conversationError = "";
      } catch (cause) {
        if (live && current === generation) conversationError = String(cause);
      }
    };
    void refresh();
    const stop = bridge.api.subscribe((id) => {
      if (id === selected) void refresh();
    });
    return () => {
      live = false;
      stop();
    };
  });
  const articleActions = $derived.by(() => {
    const bridge = articleAgent,
      vault = root,
      path = entry?.path;
    if (!bridge || !vault || !path) return undefined;
    return {
      preview: async (id: string) => {
        await bridge.api.attachVault(vault);
        return bridge.api.snapshot(id);
      },
      open: async (id: string) => {
        selectedId = id;
        tab = "chat";
      },
      report: (message: string) => workspace.report(message),
    };
  });
  async function continueConversation(): Promise<void> {
    const bridge = articleAgent,
      vault = root,
      path = entry?.path,
      selected = selectedId;
    if (!bridge || !vault || !path || !selected || opening) return;
    opening = true;
    try {
      await bridge.open(selected, { root: vault, path });
    } catch (cause) {
      conversationError = String(cause);
    } finally {
      opening = false;
    }
  }
  async function returnToArticle(): Promise<void> {
    const selected = selectedId;
    tab = "article";
    await tick();
    if (selected && !documentView?.returnToConversation(selected))
      workspace.announce("文章中的对话入口已移除，记录仍保留。");
  }
  function showInfo(): void {
    if (infoPanel.matches(":popover-open")) {
      infoPanel.hidePopover();
      return;
    }
    infoPanel.showPopover();
    const rect = infoButton.getBoundingClientRect();
    infoPanel.style.left = `${Math.max(8, Math.min(rect.right - infoPanel.offsetWidth, innerWidth - infoPanel.offsetWidth - 8))}px`;
    infoPanel.style.top = `${Math.max(8, Math.min(rect.bottom + 6, innerHeight - infoPanel.offsetHeight - 8))}px`;
  }
</script>

<section class="library-preview" aria-label="资料预览">
  <div class="preview-tabs">
    <button
      type="button"
      class="tab"
      aria-pressed={tab === "article"}
      onclick={() => {
        tab = "article";
      }}>预览</button
    >
    {#if markdown && articleAgent}<button
        type="button"
        class="tab"
        aria-pressed={tab === "chat"}
        onclick={() => {
          tab = "chat";
        }}
        >对话{#if conversations.length}<span>{conversations.length}</span>{/if}</button
      >{/if}
    <div class="preview-tools">
      {#if tab === "article" && matchState.count}<div class="matches" aria-label="文章中的匹配位置">
          <span aria-live="polite"
            >{matchState.current
              ? `${matchState.current}/${matchState.count}`
              : `${matchState.count} 处`}</span
          >
          <button
            type="button"
            aria-label="上一处匹配"
            title="上一处匹配"
            onclick={() => documentView?.moveMatch("previous")}
            ><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 12 5-5 5 5" /></svg></button
          >
          <button
            type="button"
            aria-label="下一处匹配"
            title="下一处匹配"
            onclick={() => documentView?.moveMatch("next")}
            ><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 8 5 5 5-5" /></svg></button
          >
        </div>{/if}
      <button
        type="button"
        bind:this={infoButton}
        disabled={!entry}
        aria-label="文件信息"
        title="文件信息"
        aria-controls={`${id}-info`}
        onclick={showInfo}
        ><svg viewBox="0 0 20 20" aria-hidden="true"
          ><circle cx="10" cy="10" r="7" /><path d="M10 9v5m0-9v1" /></svg
        ></button
      >
      {#if entry?.kind === "file"}<button
          type="button"
          disabled={busy}
          aria-label="打开阅读与写作"
          title="打开阅读与写作"
          onclick={() => {
            if (entry) onOpen(entry);
          }}
          ><svg viewBox="0 0 20 20" aria-hidden="true"
            ><path d="M11 3h6v6M17 3l-8 8M7 4H3v13h13v-4" /></svg
          ></button
        >{/if}
      <button
        type="button"
        class="focus-reading"
        aria-label={focused ? "返回文件列表" : "专注阅读"}
        title={focused ? "返回文件列表" : "专注阅读"}
        aria-pressed={focused}
        onclick={onFocus}
        ><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 4h14v12H3zM8 4v12" /></svg></button
      >
    </div>
  </div>
  <div
    id={`${id}-info`}
    class="file-details"
    popover="auto"
    bind:this={infoPanel}
    role="dialog"
    aria-label="文件信息"
  >
    {#if entry}<strong>{entry.path.split("/").at(-1)}</strong>
      <dl>
        <dt>位置</dt>
        <dd>
          {entry.path.includes("/")
            ? entry.path.slice(0, entry.path.lastIndexOf("/"))
            : "笔记库根目录"}
        </dd>
        <dt>类型</dt>
        <dd>{libraryEntryKind(entry)}</dd>
        {#if entry.modifiedAt !== undefined}<dt>修改</dt>
          <dd>{new Date(entry.modifiedAt).toLocaleString()}</dd>{/if}
      </dl>{/if}
  </div>
  <div class="preview-content" hidden={tab !== "article" && markdown && articleAgent !== undefined}>
    {#if !entry}<p class="preview-empty">选择文件以预览</p>
    {:else if entry.kind === "directory"}<div class="document">
        <h1>{libraryTitle(entry)}</h1>
        <p class="folder-summary">
          {descendants.filter((item) => item.kind === "file").length} 个文件
        </p>
      </div>
    {:else if loading}<p class="preview-empty" role="status">正在预览…</p>
    {:else if error}<p class="preview-empty error" role="alert">无法预览：{error}</p>
    {:else if content?.kind === "markdown"}<div class="document">
        {#key `${root}/${entry.path}`}<LibraryDocument
            bind:this={documentView}
            path={entry.path}
            source={content.source}
            {query}
            io={workspace.mediaIo}
            openLink={onFollowLink}
            onMatches={(state) => {
              matchState = state;
            }}
            {...articleActions ? { actions: articleActions } : {}}
          />{/key}
      </div>
    {:else if content?.kind === "image"}<ImagePreview path={entry.path} bytes={content.bytes} />
    {:else if content?.kind === "pdf"}<PdfPreview bytes={content.bytes} compact />
    {:else if content?.kind === "whiteboard"}<WhiteboardPreview board={content.board} />
    {:else if content?.kind === "text"}<pre>{content.source}</pre>
    {:else if content}<p class="preview-empty">此文件暂不支持内容预览。</p>{/if}
  </div>
  {#if tab === "chat" && markdown && articleAgent}<div class="conversation-panel">
      {#if listError}<p class="error" role="alert">{listError}</p>{/if}
      {#each conversations as item (item.id)}<button
          class="conversation-item"
          type="button"
          aria-pressed={item.id === selectedId}
          onclick={() => {
            selectedId = item.id;
          }}
          ><svg viewBox="0 0 20 20" aria-hidden="true"
            ><path d="M17 9a7 7 0 0 1-10 6.3L3 17l1-4A7 7 0 1 1 17 9Z" /></svg
          ><span>{item.title}</span></button
        >{/each}
      {#if conversationError}<p class="error" role="alert">{conversationError}</p>
      {:else if conversation}<div class="conversation-body">
          <div class="conversation-actions">
            <button type="button" onclick={() => void returnToArticle()}>返回原文</button>
            <button type="button" disabled={opening} onclick={() => void continueConversation()}
              >{opening ? "正在打开…" : "继续对话"}</button
            >
          </div>
          {#if conversation.archived}<p class="muted">已归档</p>{/if}
          {#each conversation.messages as message, index (index)}<div
              class="message"
              class:user={message.role === "user"}
            >
              <span>{message.role === "user" ? "你" : "Agent"}</span>
              <p>{message.text}</p>
            </div>{/each}
          {#if conversation.messages.length === 0}<p class="muted">还没有消息</p>{/if}
        </div>
      {:else if selectedId}<p class="muted" role="status">正在读取…</p>
      {:else}<p class="muted">暂无对话</p>{/if}
    </div>{/if}
</section>

<style>
  .library-preview {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    background: var(--bg);
  }
  .preview-tabs {
    display: flex;
    align-items: stretch;
    gap: 18px;
    min-height: 47px;
    padding: 0 24px;
    border-bottom: 1px solid var(--border);
    box-sizing: border-box;
  }
  button {
    color: inherit;
    font: inherit;
    border: 0;
    background: transparent;
    cursor: pointer;
    border-radius: 4px;
  }
  button:hover:not(:disabled) {
    background: var(--selected);
  }
  button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .tab {
    font-size: 12px;
    color: var(--muted);
    border-radius: 0;
    border-bottom: 2px solid transparent;
    padding: 3px 0;
  }
  .tab[aria-pressed="true"] {
    color: var(--fg);
    border-bottom-color: var(--accent);
  }
  .tab span {
    margin-left: 5px;
    font-size: 11px;
    color: var(--muted);
  }
  .preview-tools {
    display: flex;
    align-items: center;
    gap: 3px;
    margin-left: auto;
  }
  .preview-tools button {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    min-height: 28px;
    padding: 2px;
    color: var(--muted);
  }
  svg {
    width: 14px;
    height: 14px;
    flex-shrink: 0;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .matches {
    display: flex;
    align-items: center;
    gap: 1px;
    font-size: 11px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
    margin-right: 4px;
  }
  .preview-content,
  .conversation-panel {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }
  .preview-content[hidden] {
    display: none;
  }
  .document {
    max-width: 740px;
    margin: 0 auto;
    padding: 30px 35px;
    overflow-wrap: anywhere;
  }
  .document h1 {
    font-family: var(--font-reading-family, serif);
    font-weight: 500;
    font-size: 28px;
    margin: 0 0 24px;
  }
  .preview-empty,
  .folder-summary {
    padding: 20px;
    font-size: 13px;
    color: var(--muted);
  }
  .folder-summary {
    padding: 0;
  }
  pre {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    padding: 24px;
    font-size: 13px;
  }
  .file-details {
    position: fixed;
    inset: auto;
    margin: 0;
    width: min(292px, calc(100vw - 16px));
    box-sizing: border-box;
    padding: 14px 16px;
    color: var(--fg);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    box-shadow: 0 6px 24px var(--shadow);
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  .file-details strong {
    font-weight: 500;
  }
  dl {
    display: grid;
    grid-template-columns: 32px minmax(0, 1fr);
    gap: 8px 10px;
    margin: 12px 0 0;
  }
  dt {
    color: var(--muted);
  }
  dd {
    margin: 0;
  }
  .conversation-panel {
    padding: 16px 24px;
  }
  .conversation-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    text-align: left;
    padding: 7px 9px;
    font-size: 12px;
  }
  .conversation-item[aria-pressed="true"] {
    background: var(--selected);
  }
  .conversation-item span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .conversation-item svg {
    color: var(--muted);
  }
  .conversation-body {
    border-top: 1px solid var(--border);
    margin-top: 16px;
    padding-top: 10px;
  }
  .conversation-actions {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    color: var(--accent);
    font-size: 12px;
  }
  .conversation-actions button {
    padding: 5px;
  }
  .message {
    margin: 20px 0;
  }
  .message > span {
    font-size: 11px;
    font-weight: 500;
  }
  .message p {
    font-size: 13px;
    line-height: 1.9;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    margin: 7px 0 0;
  }
  .message.user p {
    padding: 9px 12px;
    border-radius: 5px;
    background: var(--sidebar);
  }
  .muted {
    color: var(--muted);
    font-size: 12px;
  }
  .error {
    color: var(--danger);
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  @media (max-width: 800px) {
    .preview-tabs {
      padding: 0 15px;
      gap: 12px;
    }
    .document {
      padding: 25px;
    }
  }
  @media (pointer: coarse) {
    .preview-tools button {
      min-width: 44px;
      min-height: 44px;
    }
    .preview-tabs {
      flex-wrap: wrap;
    }
  }
</style>
