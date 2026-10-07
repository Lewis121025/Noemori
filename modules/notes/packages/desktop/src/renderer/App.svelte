<script lang="ts">
  /** 应用装配入口：拥有应用生命周期，阅读器通过显式接口参与关闭流程。 */
  import { onMount, tick } from "svelte";
  import ReaderWorkspace from "../features/reader/renderer/ReaderWorkspace.svelte";
  import AppearanceOptions from "./AppearanceOptions.svelte";
  import ReadingFontOptions from "./ReadingFontOptions.svelte";
  import ReadingPaletteOptions from "./ReadingPaletteOptions.svelte";
  import { createArticleAgentActions } from "./article-agent";
  import AgentPanel from "../features/agent/renderer/AgentPanel.svelte";
  import {
    DEFAULT_READING_PALETTE,
    type ReadingPalette,
  } from "../features/reader/shared/reading-palette";
  import type { HistoryAction, HistoryAvailability } from "../features/reader/shared/api";
  import { InputHistory } from "./input-history";

  const { app, reader: readerApi } = window.noemori;
  let reader: ReaderWorkspace | undefined = $state();
  let showAgent = $state(false);
  let selectedConversation = $state<string | null>(null);
  let articleFilter = $state<{ root: string; path: string } | null>(null);
  const articleAgent = createArticleAgentActions(window.noemori.agent, openArticleAgent);
  async function prepareAgentRun(): Promise<void> {
    if (!(await reader?.flushBeforeClose())) throw new Error("请先处理文章保存问题，再发送消息");
  }
  async function openArticleAgent(
    id: string | null,
    article: { root: string; path: string },
  ): Promise<void> {
    if ((await agentPanel?.prepareToLeave()) === false) return;
    await agentPanel?.flushDraft();
    await prepareAgentRun();
    await window.noemori.agent.attachVault(article.root);
    showAgent = false;
    await tick();
    selectedConversation = id;
    articleFilter = article;
    showAgent = true;
  }
  async function returnToArticle(root: string, path: string, marker: string): Promise<void> {
    if ((await agentPanel?.prepareToLeave()) === false) return;
    await agentPanel?.flushDraft();
    await reader?.openArticle(root, path, marker);
    showAgent = false;
    await tick();
    reader?.focusDocument();
  }
  let agentPanel: AgentPanel | undefined = $state();
  let closeError = $state("");
  async function toggleAgent(): Promise<void> {
    try {
      if (showAgent) {
        if ((await agentPanel?.prepareToLeave()) === false) return;
        await agentPanel?.flushDraft();
        await window.noemori.agent.flush();
      }
      showAgent = !showAgent;
      articleFilter = null;
      closeError = "";
    } catch (cause) {
      closeError = cause instanceof Error ? cause.message : String(cause);
    }
  }
  async function closeAgent(): Promise<void> {
    if ((await agentPanel?.prepareToLeave()) === false) return;
    showAgent = false;
    await tick();
    document.querySelector<HTMLButtonElement>('.window-toolbar [aria-label="工作区助手"]')?.focus();
  }
  let readingPalette = $state<ReadingPalette>(DEFAULT_READING_PALETTE);
  let historyContext = $state(0);
  let publishedHistory: HistoryAvailability | null = null;
  const inputHistory = new InputHistory(
    () => showAgent || reader?.historyAvailability() === null,
    refreshHistoryContext,
  );

  function refreshHistoryContext(): void {
    historyContext += 1;
  }

  function executeHistory(action: HistoryAction): void {
    if (showAgent || !reader?.executeHistory(action)) inputHistory.apply(action);
    refreshHistoryContext();
  }

  $effect(() => {
    // 文档事务由响应式 API 跟踪，辅助输入由各控件历史通知；菜单只投影可用性。
    void historyContext;
    const next = showAgent
      ? inputHistory.availability()
      : (reader?.historyAvailability() ?? inputHistory.availability());
    if (publishedHistory?.undo === next.undo && publishedHistory.redo === next.redo) return;
    publishedHistory = next;
    app.historyChanged(next);
  });

  onMount(() =>
    app.subscribeCommand((command) => {
      if (command === "undo" || command === "redo") {
        executeHistory(command);
      } else if (showAgent) {
        void (async () => {
          try {
            if (command !== "save" && (await agentPanel?.prepareToLeave()) === false) return;
            await agentPanel?.flushDraft();
            await window.noemori.agent.flush();
            if (command !== "save") {
              await closeAgent();
              reader?.executeCommand(command);
            }
          } catch (cause) {
            closeError = cause instanceof Error ? cause.message : String(cause);
          }
        })();
      } else reader?.executeCommand(command);
    }),
  );

  onMount(() => inputHistory.bind(document, executeHistory));

  onMount(() =>
    app.subscribeFlushBeforeClose(() => {
      void requestClose();
    }),
  );

  async function requestClose(): Promise<void> {
    try {
      if ((await agentPanel?.prepareToLeave()) === false) {
        await app.closeBlocked();
        return;
      }
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

<ReaderWorkspace
  {articleAgent}
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
</ReaderWorkspace>
{#if showAgent}<AgentPanel
    bind:articleFilter
    beforeSend={prepareAgentRun}
    onOpenArticle={returnToArticle}
    bind:this={agentPanel}
    bind:selected={selectedConversation}
    api={window.noemori.agent}
    close={() => void closeAgent()}
    openLink={readerApi.openExternal}
  />{/if}
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
