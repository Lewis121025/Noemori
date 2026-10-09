<script lang="ts">
  /** 应用装配入口：拥有应用生命周期，阅读器通过显式接口参与关闭流程。 */
  import { onMount, tick } from "svelte";
  import ReaderWorkspace from "../features/reader/renderer/ReaderWorkspace.svelte";
  import AppearanceOptions from "./AppearanceOptions.svelte";
  import ReadingFontOptions from "./ReadingFontOptions.svelte";
  import ReadingPaletteOptions from "./ReadingPaletteOptions.svelte";
  import { createArticleAgentActions } from "./article-agent";
  import AgentPanel from "../features/agent/renderer/AgentPanel.svelte";
  import ModelSettings from "../features/agent/renderer/ModelSettings.svelte";
  import {
    DEFAULT_READING_PALETTE,
    type ReadingPalette,
  } from "../features/reader/shared/reading-palette";
  import type { HistoryAction, HistoryAvailability } from "../features/reader/shared/api";
  import type { AgentConversationInfo } from "../features/agent/shared/api";
  import type { WorkspaceConversations } from "../features/reader/shared/workspace-conversations";
  import type { ReaderCommand } from "../features/reader/shared/commands";
  import type { AgentReference } from "../features/agent/shared/references";
  import { InputHistory } from "./input-history";

  const { app, reader: readerApi } = window.noemori;
  let reader: ReaderWorkspace | undefined = $state();
  let showAgent = $state(false);
  let selectedConversation = $state<string | null>(null);
  let conversationItems = $state<AgentConversationInfo[]>([]);
  const conversations: WorkspaceConversations = {
    get items() {
      return conversationItems;
    },
    get selected() {
      return selectedConversation;
    },
    async open(id) {
      showAgent = true;
      if (!(await agentPanel?.selectConversation(id))) return;
      const item = conversationItems.find((item) => item.id === id);
      if (
        item?.article &&
        item.workspace !== null &&
        !item.article.removed &&
        item.article.status !== "article-missing" &&
        reader?.vaultRoot() === item.workspace
      )
        await reader.openArticle(item.workspace, item.article.path, item.article.markerId);
      await tick();
      agentPanel?.focusComposer(id);
    },
    async create(directory) {
      showAgent = true;
      await tick();
      await agentPanel?.createConversation(directory);
    },
    async manage(id, action) {
      showAgent = true;
      await tick();
      await agentPanel?.manageConversation(id, action);
    },
  };
  let articleFilter = $state<{ root: string; path: string } | null>(null);
  const articleAgent = createArticleAgentActions(
    window.noemori.agent,
    openArticleAgent,
    async () => {
      await agentPanel?.refreshList();
    },
  );
  async function prepareAgentRun(): Promise<void> {
    if (!(await reader?.flushBeforeClose())) throw new Error("请先处理文章保存问题，再发送消息");
  }
  async function openArticleAgent(
    id: string | null,
    article: { root: string; path: string },
  ): Promise<void> {
    await prepareAgentRun();
    await window.noemori.agent.attachVault(article.root);
    showAgent = true;
    if (await agentPanel?.openArticleConversation(id, article)) {
      await tick();
      if (selectedConversation) agentPanel?.focusComposer(selectedConversation);
    }
  }
  async function addSelectedReference(reference: AgentReference): Promise<void> {
    showAgent = true;
    await tick();
    if (!agentPanel) throw new Error("对话输入框尚未就绪，请重试");
    await agentPanel.addSelectedReference(reference);
  }
  async function openReference(reference: AgentReference): Promise<void> {
    if (!reference.source || !reader) throw new Error("此引用没有可打开的文件来源");
    await agentPanel?.flushDraft();
    await reader.openReference(reference.source);
  }
  async function returnToArticle(root: string, path: string, marker: string): Promise<void> {
    await agentPanel?.flushDraft();
    await reader?.openArticle(root, path, marker);
    await tick();
    reader?.focusDocument();
  }
  let agentPanel: AgentPanel | undefined = $state();
  let modelSettings: ModelSettings | undefined = $state();
  let modelCatalogVersion = $state(0);
  let closeError = $state("");
  async function toggleAgent(): Promise<void> {
    try {
      if (showAgent) {
        if ((await agentPanel?.prepareToHide()) === false) return;
      }
      showAgent = !showAgent;
      closeError = "";
    } catch (cause) {
      closeError = cause instanceof Error ? cause.message : String(cause);
    }
  }
  async function closeAgent(): Promise<void> {
    showAgent = false;
    await tick();
    document.querySelector<HTMLButtonElement>('.window-toolbar [aria-label="工作区助手"]')?.focus();
  }
  let readingPalette = $state<ReadingPalette>(DEFAULT_READING_PALETTE);
  let historyContext = $state(0);
  let publishedHistory: HistoryAvailability | null = null;
  const inputHistory = new InputHistory(
    () => agentHasFocus() || reader?.historyAvailability() === null,
    refreshHistoryContext,
  );

  function refreshHistoryContext(): void {
    historyContext += 1;
  }

  function agentHasFocus(): boolean {
    return (
      document.activeElement instanceof Element &&
      document.activeElement.closest(".agent-panel") !== null
    );
  }

  function executeHistory(action: HistoryAction): void {
    if (agentHasFocus() || !reader?.executeHistory(action)) inputHistory.apply(action);
    refreshHistoryContext();
  }

  $effect(() => {
    // 文档事务由响应式 API 跟踪，辅助输入由各控件历史通知；菜单只投影可用性。
    void historyContext;
    const next = agentHasFocus()
      ? inputHistory.availability()
      : (reader?.historyAvailability() ?? inputHistory.availability());
    if (publishedHistory?.undo === next.undo && publishedHistory.redo === next.redo) return;
    publishedHistory = next;
    app.historyChanged(next);
  });

  function executeCommand(command: ReaderCommand | HistoryAction): void {
    if (command === "undo" || command === "redo") {
      executeHistory(command);
      return;
    }
    if (command === "save") {
      void (async () => {
        try {
          await agentPanel?.flushDraft();
          await window.noemori.agent.flush();
          reader?.executeCommand(command);
        } catch (cause) {
          closeError = cause instanceof Error ? cause.message : String(cause);
        }
      })();
    } else reader?.executeCommand(command);
  }
  onMount(() => app.subscribeCommand(executeCommand));

  onMount(() => inputHistory.bind(document, executeHistory));

  onMount(() =>
    app.subscribeFlushBeforeClose(() => {
      void requestClose();
    }),
  );

  async function requestClose(): Promise<void> {
    try {
      await agentPanel?.flushDraft();
      await window.noemori.agent.flush();
      const ready = (await reader?.flushBeforeClose()) ?? false;
      if (ready) await app.closeAfterFlush();
      else await app.closeBlocked();
    } catch (cause) {
      closeError = `暂时无法关闭：${cause instanceof Error ? cause.message : String(cause)}`;
      await app.closeBlocked();
    }
  }
</script>

<svelte:document
  onfocusin={refreshHistoryContext}
  onfocusout={refreshHistoryContext}
  oninput={refreshHistoryContext}
  onselectionchange={refreshHistoryContext}
/>

{#snippet agentContent()}
  <AgentPanel
    bind:articleFilter
    beforeSend={prepareAgentRun}
    onOpenArticle={returnToArticle}
    onOpenReference={openReference}
    bind:this={agentPanel}
    bind:selected={selectedConversation}
    api={window.noemori.agent}
    {modelCatalogVersion}
    onConfigure={() => reader?.openModelSettings()}
    onList={(items) => (conversationItems = items)}
    close={() => void closeAgent().catch((cause) => (closeError = String(cause)))}
    openLink={readerApi.openExternal}
  />
{/snippet}
<ReaderWorkspace
  {articleAgent}
  onAddReference={addSelectedReference}
  {conversations}
  onCommand={executeCommand}
  agentPanel={agentContent}
  beforeModelLeave={() => modelSettings?.confirmLeave() ?? Promise.resolve(true)}
  api={readerApi}
  palette={readingPalette}
  bind:this={reader}
  agentOpen={showAgent}
  onOpenAgent={() => void toggleAgent()}
>
  {#snippet applicationMenu()}
    <AppearanceOptions api={app} />
    <ReadingPaletteOptions api={app} onApply={(palette) => (readingPalette = palette)} />
    <ReadingFontOptions
      api={app}
      onApply={async (font) => {
        await reader?.applyReadingFont(font);
      }}
    />
  {/snippet}
  {#snippet modelPreferences()}
    <ModelSettings
      bind:this={modelSettings}
      api={window.noemori.agent}
      saved={() => (modelCatalogVersion += 1)}
    />
  {/snippet}
</ReaderWorkspace>
{#if closeError}<p class="close-error" role="alert">{closeError}</p>{/if}

<style>
  .close-error {
    position: fixed;
    z-index: 100;
    top: 48px;
    left: 50%;
    transform: translateX(-50%);
    max-width: calc(100vw - 2rem);
    margin: 0;
    padding: 0.75rem 1rem;
    color: var(--danger);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: 0 4px 20px var(--shadow);
    font-size: 0.8rem;
  }
</style>
