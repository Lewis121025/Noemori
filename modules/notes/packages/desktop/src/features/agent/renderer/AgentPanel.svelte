<script lang="ts">
  import { onMount, onDestroy, tick } from "svelte";
  import type {
    AgentApi,
    AgentApproval,
    AgentConversation,
    AgentConversationInfo,
    ApprovalReply,
  } from "../shared/api";
  import { canResumeRun } from "../shared/run-actions";
  import ForkConversationDialog from "./ForkConversationDialog.svelte";
  import ConversationRelations from "./ConversationRelations.svelte";
  import ConversationList from "./ConversationList.svelte";
  import ConversationMessages from "./ConversationMessages.svelte";
  import ConversationActions, { type ConversationAction } from "./ConversationActions.svelte";
  import NewConversationDialog from "./NewConversationDialog.svelte";
  import ModelSettings from "./ModelSettings.svelte";
  import AgentTerminal from "./AgentTerminal.svelte";
  import AgentBrowser from "./AgentBrowser.svelte";
  import { createCompositionGuard } from "../../reader/shared/composition";
  let {
    api,
    close,
    openLink,
    selected = $bindable<string | null>(null),
    articleFilter = $bindable<{ root: string; path: string } | null>(null),
    beforeSend,
    onOpenArticle,
  }: {
    selected?: string | null;
    articleFilter?: { root: string; path: string } | null;
    beforeSend?: () => Promise<void>;
    onOpenArticle?: (root: string, path: string, markerId: string) => Promise<void>;
    api: AgentApi;
    close: () => void;
    openLink: (url: string) => Promise<void>;
  } = $props();
  let items = $state<AgentConversationInfo[]>([]);
  let current = $state<AgentConversation | null>(null);
  let prompt = $state("");
  let savedDraft = $state("");
  let error = $state("");
  let issues = $state<string[]>([]);
  let settings = $state(false);
  let modelSettings: ModelSettings | undefined = $state();
  let pendingCreate = false;
  let loading = $state(true);
  let sending = $state(false);
  let stoppingIds = $state<string[]>([]);
  let continuingIds = $state<string[]>([]);
  let approving = $state(false);
  let closing = $state(false);
  let listShown = $state(false);
  let windowWidth = $state(1100);
  let headerHeight = $state(74);
  let listToggle: HTMLButtonElement;
  const drawerOpen = $derived(listShown && windowWidth <= 800);
  let listArchived = $state(false);
  let listQuery = $state("");
  let terminalShown = $state(false);
  let terminalId = $state<string | null>(null);
  let selectionVersion = 0;
  let refreshVersion = 0;
  let listVersion = 0;
  let live = true;
  let draftTimer: ReturnType<typeof setTimeout> | undefined;
  const composition = createCompositionGuard();
  let createDialog: NewConversationDialog;
  let forkDialog: ForkConversationDialog;
  let messagesView: ConversationMessages | undefined = $state();
  let actionDialog: ConversationActions;
  let moreMenu: HTMLDivElement | undefined = $state();
  const workspaces = $derived([...new Set(items.map((item) => item.workspace))]);
  const terminal = $derived(
    current?.terminals.find((entry) => entry.process.session_id === terminalId) ??
      current?.terminals.at(-1) ??
      null,
  );
  const statusLabels = {
    running: "正在处理",
    completed: "已完成",
    cancelled: "已中断",
    timed_out: "本次任务超时",
    budget_exhausted: "本次任务达到运行上限",
    truncated: "回复达到长度上限",
    filtered: "回复未能完成",
    failed: "本次任务未完成",
  };

  function report(cause: unknown): void {
    if (live) error = cause instanceof Error ? cause.message : String(cause);
  }
  async function list(): Promise<void> {
    const version = ++listVersion;
    const result = await api.list();
    if (!live || version !== listVersion) return;
    items = result.items;
    issues = result.issues;
  }
  async function refresh(id: string): Promise<void> {
    await list();
    if (selected !== id || !items.some((item) => item.id === id)) return;
    const version = ++refreshVersion;
    const selection = selectionVersion;
    const snapshot = await api.snapshot(id);
    if (live && selected === id && selection === selectionVersion && version === refreshVersion)
      current = snapshot;
  }

  /** 关闭面板、切换会话和退出窗口都先提交当前草稿，失败时保留界面与输入。 */
  export async function flushDraft(): Promise<void> {
    if (draftTimer !== undefined) clearTimeout(draftTimer);
    draftTimer = undefined;
    const item = current;
    if (!item || prompt === savedDraft) return;
    const value = prompt;
    await api.saveDraft(item.id, value);
    if (current?.id === item.id && prompt === value) savedDraft = value;
  }
  function draftChanged(): void {
    if (draftTimer !== undefined) clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      draftTimer = undefined;
      void flushDraft().catch(report);
    }, 400);
  }
  async function select(id: string): Promise<void> {
    if (!(await prepareToLeave())) return;
    const version = ++selectionVersion;
    loading = true;
    error = "";
    try {
      await flushDraft();
      const snapshot = await api.snapshot(id);
      if (!live || selectionVersion !== version) return;
      selected = id;
      current = snapshot;
      listArchived = snapshot.archived;
      prompt = snapshot.draft;
      savedDraft = prompt;
      settings = false;
      listShown = false;
      terminalShown = false;
      terminalId = null;
    } catch (cause) {
      report(cause);
    } finally {
      if (live && selectionVersion === version) loading = false;
    }
  }
  async function initialize(): Promise<void> {
    try {
      await list();
      const first =
        items.find((item) => item.id === selected) ??
        items.find(
          (item) =>
            !item.archived &&
            (!articleFilter ||
              (item.workspace === articleFilter.root && item.article?.path === articleFilter.path)),
        );
      if (first) listArchived = first.archived;
      if (first) await select(first.id);
    } catch (cause) {
      report(cause);
    } finally {
      if (live) loading = false;
    }
  }
  onMount(() => {
    void initialize();
    return api.subscribe((id) => {
      void refresh(id).catch(report);
    });
  });
  onDestroy(() => {
    live = false;
    selectionVersion += 1;
    if (draftTimer !== undefined) clearTimeout(draftTimer);
  });

  async function beginFork(turnId: string | null = null): Promise<void> {
    const item = current;
    if (!item) return;
    moreMenu?.hidePopover();
    try {
      await flushDraft();
      await forkDialog.open(item, turnId);
    } catch (cause) {
      report(cause);
    }
  }
  async function selectRelation(id: string, turnId?: string | null): Promise<void> {
    listQuery = "";
    await select(id);
    await tick();
    if (selected === id && turnId) messagesView?.focusTurn(turnId);
  }
  async function beginCreate(): Promise<void> {
    try {
      if (!(await prepareToLeave())) return;
      await flushDraft();
      if ((await api.settingsGet()) === null) {
        pendingCreate = true;
        settings = true;
        error = "请先配置模型接口，再创建对话。";
        return;
      }
      await createDialog.open(current?.workspace ?? workspaces[0] ?? "");
    } catch (cause) {
      report(cause);
    }
  }
  async function created(item: AgentConversation): Promise<void> {
    listArchived = false;
    listQuery = "";
    await list();
    await select(item.id);
  }
  async function settingsSaved(): Promise<void> {
    error = "";
    if (pendingCreate) {
      pendingCreate = false;
      settings = false;
      await createDialog.open(current?.workspace ?? workspaces[0] ?? "");
    }
  }
  async function closePanel(): Promise<void> {
    if (closing) return;
    closing = true;
    try {
      if (!(await prepareToLeave())) return;
      await flushDraft();
      await api.flush();
      close();
    } catch (cause) {
      report(cause);
    } finally {
      closing = false;
    }
  }
  /**
   * 应用关闭、切换会话与文章跳转在丢弃配置页前确认未保存输入。
   * @returns 配置页允许离开时返回 true，取消或保存中返回 false；不发送模型请求。
   */
  export function prepareToLeave(): Promise<boolean> {
    return settings && modelSettings ? modelSettings.confirmLeave() : Promise.resolve(true);
  }
  async function send(): Promise<void> {
    const item = current;
    if (
      !item ||
      item.archived ||
      sending ||
      loading ||
      composition.active ||
      item.run?.status === "running" ||
      !prompt.trim()
    )
      return;
    sending = true;
    error = "";
    try {
      await flushDraft();
      await beforeSend?.();
      await api.start(item.id, prompt);
      if (selected === item.id) {
        prompt = "";
        savedDraft = "";
      }
    } catch (cause) {
      report(cause);
    } finally {
      sending = false;
      await refresh(item.id).catch(report);
    }
  }
  async function interruptRun(): Promise<void> {
    const item = current;
    const run = item?.run;
    if (!item || !run || stoppingIds.includes(item.id)) return;
    stoppingIds = [...stoppingIds, item.id];
    error = "";
    try {
      await api.cancel(item.id, run.id);
      await refresh(item.id);
    } catch (cause) {
      report(cause);
    } finally {
      stoppingIds = stoppingIds.filter((id) => id !== item.id);
    }
  }
  async function continueRun(): Promise<void> {
    const item = current;
    const run = item?.run;
    if (
      !item ||
      !run ||
      item.archived ||
      loading ||
      sending ||
      stoppingIds.includes(item.id) ||
      continuingIds.includes(item.id) ||
      !canResumeRun(run)
    )
      return;
    continuingIds = [...continuingIds, item.id];
    error = "";
    try {
      await flushDraft();
      await beforeSend?.();
      await api.resume(item.id, run.id);
      await refresh(item.id);
    } catch (cause) {
      report(cause);
    } finally {
      continuingIds = continuingIds.filter((id) => id !== item.id);
    }
  }
  async function decision(
    approval: AgentApproval,
    choice: "allow_once" | "allow_for_session" | "deny",
  ): Promise<void> {
    if (!current || approving) return;
    const id = current.id;
    approving = true;
    const reply: ApprovalReply = {
      type: approval.request.type,
      decision:
        choice === "deny" ? { decision: choice, details: "用户拒绝" } : { decision: choice },
    };
    try {
      await api.approve(id, approval.id, reply);
      await refresh(id);
    } catch (cause) {
      report(cause);
    } finally {
      approving = false;
    }
  }
  async function manage(action: ConversationAction): Promise<void> {
    moreMenu?.hidePopover();
    const item = current;
    if (!item) return;
    try {
      await flushDraft();
      await actionDialog.open(action, item);
    } catch (cause) {
      report(cause);
    }
  }
  async function managed(action: ConversationAction, id: string): Promise<void> {
    if (action !== "rename" && selected === id) {
      selected = null;
      current = null;
      prompt = "";
      savedDraft = "";
    }
    await list();
    if (action === "rename") await refresh(id);
    else {
      const next = items.find(
        (item) =>
          !item.archived &&
          (!articleFilter ||
            (item.workspace === articleFilter.root && item.article?.path === articleFilter.path)),
      );
      if (next) {
        listArchived = false;
        listQuery = "";
        await select(next.id);
      }
    }
  }
  async function restore(): Promise<void> {
    if (!current) return;
    const id = current.id;
    try {
      await api.archive(id, false);
      listArchived = false;
      listQuery = "";
      await refresh(id);
    } catch (cause) {
      report(cause);
    }
  }
  async function openTerminal(): Promise<void> {
    if (!current || current.archived) return;
    const id = current.id;
    try {
      await api.terminalAction(id, {
        action: "exec",
        cmd: "/bin/sh -i",
        tty: true,
        yield_time_ms: 0,
      });
      await refresh(id);
    } catch (cause) {
      report(cause);
    }
  }
</script>

<svelte:window
  bind:innerWidth={windowWidth}
  onkeydown={(event) => {
    if (
      drawerOpen &&
      event.key === "Escape" &&
      !event.defaultPrevented &&
      !composition.active &&
      !document.querySelector("dialog[open]")
    ) {
      event.preventDefault();
      listShown = false;
      listToggle.focus();
    }
  }}
/>
<aside
  class="agent-panel"
  aria-label="工作区助手"
  style:--conversation-header-height={`${headerHeight}px`}
>
  {#if drawerOpen}<button
      type="button"
      class="list-scrim"
      aria-label="收起对话列表"
      onclick={() => {
        listShown = false;
        listToggle.focus();
      }}
    ></button>{/if}
  <div class="conversation-sidebar" class:shown={listShown}>
    <ConversationList
      {articleFilter}
      onClearArticle={() => (articleFilter = null)}
      {items}
      {selected}
      {loading}
      bind:archived={listArchived}
      bind:query={listQuery}
      onSelect={(id) => void select(id)}
      onCreate={() => void beginCreate()}
      onSettings={() => {
        settings = true;
        listShown = false;
      }}
    />
  </div>
  <main class="conversation-main">
    <header class="conversation-header" bind:offsetHeight={headerHeight}>
      <button
        class="reader-button list-toggle"
        bind:this={listToggle}
        type="button"
        aria-label="显示对话列表"
        aria-expanded={listShown}
        onclick={() => (listShown = !listShown)}>对话</button
      >
      <div class="conversation-heading">
        <h1>{settings ? "模型接口" : (current?.title ?? "工作区助手")}</h1>
        {#if !settings && current}<p title={current.workspace}>{current.workspace}</p>{/if}
      </div>
      {#if current && !settings}<span class="model-badge" title={current.model}
          >{current.model}</span
        >
        <button
          class="reader-button"
          type="button"
          popovertarget="conversation-menu"
          aria-label="对话操作">•••</button
        >
        <div
          id="conversation-menu"
          popover="auto"
          bind:this={moreMenu}
          class="reader-popover conversation-menu"
        >
          <button class="reader-button" type="button" onclick={() => void beginFork()}
            >分叉对话…</button
          >
          <button class="reader-button" type="button" onclick={() => void manage("rename")}
            >重命名对话</button
          >
          {#if !current.archived}<button
              class="reader-button"
              type="button"
              onclick={() => void manage("archive")}>归档对话</button
            >{/if}
          <button class="reader-button danger" type="button" onclick={() => void manage("remove")}
            >删除对话</button
          >
        </div>{/if}
      <button
        class="reader-button return-notes"
        type="button"
        aria-label="关闭助手"
        disabled={closing}
        onclick={() => void closePanel()}>返回笔记</button
      >
    </header>
    <div class="conversation-content" inert={drawerOpen}>
      {#if issues.length > 0}<details class="storage-issues">
          <summary>有 {issues.length} 条记录需要处理</summary>{#each issues as issue (issue)}<p>
              {issue}
            </p>{/each}
        </details>{/if}
      {#if error}<div class="panel-error" role="alert">
          <span>{error}</span><button
            class="reader-button"
            type="button"
            aria-label="关闭提示"
            onclick={() => (error = "")}>×</button
          >
        </div>{/if}
      {#if current?.storageError}<div class="panel-error" role="alert">
          <span>{current.storageError}</span><button
            class="reader-button"
            type="button"
            onclick={() =>
              void api
                .flush()
                .then(() => (selected ? refresh(selected) : list()))
                .catch(report)}>重试保存</button
          >
        </div>{/if}
      {#if settings}<div class="settings-page">
          <ModelSettings
            bind:this={modelSettings}
            {api}
            saved={() => void settingsSaved().catch(report)}
            close={() => (settings = false)}
          />
        </div>
      {:else if current}
        {#if current.article}<div class="article-source">
            <div><strong>{current.article.title}</strong><span>{current.article.path}</span></div>
            {#if current.article.status === "located"}<span
                >{current.article.heading ?? "正文"} · 第 {current.article.line} 行</span
              >
            {:else}<span
                >{current.article.error ??
                  (current.article.status === "article-missing"
                    ? "来源文章已移除 · 历史保留"
                    : current.article.status === "ambiguous"
                      ? "文章中有重复入口，请核对位置"
                      : "文中入口已移除 · 历史保留")}</span
              >{/if}
            {#if onOpenArticle}<button
                class="reader-button"
                type="button"
                disabled={current.article.status === "article-missing"}
                onclick={() => {
                  const item = current;
                  if (item?.article)
                    void onOpenArticle?.(
                      item.workspace,
                      item.article.path,
                      item.article.markerId,
                    ).catch(report);
                }}>返回原段落</button
              >{/if}
          </div>{/if}
        <ConversationRelations
          {current}
          {items}
          onSelect={(id, turnId) => void selectRelation(id, turnId)}
        />
        {#if current.archived}<div class="archived-notice">
            <span>此对话已归档，历史记录仍可阅读。</span><button
              class="reader-button"
              type="button"
              onclick={() => void restore()}>恢复对话</button
            >
          </div>{/if}
        {#key current.id}<ConversationMessages
            bind:this={messagesView}
            onFork={(turnId) => void beginFork(turnId)}
            {current}
            {openLink}
            {approving}
            onApprove={(approval, choice) => void decision(approval, choice)}
          />{/key}
        {#if current.run && current.run.status !== "completed" && current.run.status !== "running"}<div
            class="run-notice"
          >
            <strong>{statusLabels[current.run.status]}</strong>{#if current.run.error}<span
                >{current.run.error}</span
              >{/if}
            {#if !current.archived && canResumeRun(current.run)}
              <button
                class="reader-button"
                type="button"
                disabled={loading ||
                  sending ||
                  stoppingIds.includes(current.id) ||
                  continuingIds.includes(current.id)}
                onclick={() => void continueRun()}
                >{continuingIds.includes(current.id) ? "正在继续…" : "继续任务"}</button
              >
            {/if}
          </div>{/if}
        {#if current.browser.status !== "idle"}<div class="browser-region">
            <AgentBrowser {api} session={current.id} browser={current.browser} />
          </div>{/if}
        {#if terminalShown}<section class="terminal-drawer" aria-label="会话终端">
            <header>
              <strong>终端</strong>
              {#if current.terminals.length > 0}<select
                  aria-label="终端记录"
                  bind:value={terminalId}
                  ><option value={null}>最近终端</option
                  >{#each current.terminals as entry, index (entry.process.session_id)}<option
                      value={entry.process.session_id}
                      >终端 {index + 1} · {entry.process.status === "running"
                        ? "运行中"
                        : "已结束"}</option
                    >{/each}</select
                >{/if}
              <button
                class="reader-button"
                type="button"
                disabled={current.archived}
                onclick={() => void openTerminal()}>新终端</button
              >
              <button class="reader-button" type="button" onclick={() => (terminalShown = false)}
                >收起</button
              >
            </header>
            {#if terminal}{#key `${current.id}:${terminal.process.session_id}`}<AgentTerminal
                  {api}
                  session={current.id}
                  {terminal}
                />{/key}{:else}<p>尚未打开终端。终端仅在本次应用运行期间保留。</p>{/if}
          </section>{/if}
        {#if !current.archived}<form
            class="composer"
            use:composition.bind
            onsubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <textarea
              bind:value={prompt}
              aria-label="Agent 用户任务"
              placeholder="描述想完成的任务…"
              rows="3"
              disabled={loading || sending}
              oninput={draftChanged}
              onkeydown={(event) => {
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.isComposing &&
                  event.keyCode !== 229
                ) {
                  event.preventDefault();
                  void send();
                }
              }}
            ></textarea>
            <div class="composer-actions">
              <button
                class="reader-button"
                type="button"
                aria-expanded={terminalShown}
                onclick={() => (terminalShown = !terminalShown)}>终端</button
              >
              <span class="composer-hint"
                >{prompt
                  ? prompt === savedDraft
                    ? "草稿已保存"
                    : "正在保存草稿…"
                  : "Enter 发送 · Shift+Enter 换行"}</span
              >
              {#if current.run?.status === "running"}<button
                  class="reader-button"
                  type="button"
                  disabled={stoppingIds.includes(current.id)}
                  onclick={() => void interruptRun()}
                  >{stoppingIds.includes(current.id) ? "正在停止…" : "停止生成"}</button
                >
              {:else}<button
                  class="reader-button primary"
                  type="submit"
                  disabled={loading || sending || !prompt.trim()}
                  >{sending ? "正在发送…" : "发送"}</button
                >{/if}
            </div>
          </form>{/if}
      {:else}<section class="agent-empty">
          {#if articleFilter}<h2>这篇文章还没有对话</h2>
            <p>返回正文，在想讨论的位置选择“插入 Agent 对话”。</p>
            <button
              class="reader-button primary"
              type="button"
              onclick={() => {
                if (articleFilter)
                  void onOpenArticle?.(articleFilter.root, articleFilter.path, "").catch(report);
              }}>返回文章</button
            >
          {:else}
            <span class="empty-symbol" aria-hidden="true">✦</span>
            <h2>和助手一起推进工作</h2>
            <p>每条对话都有独立的工作目录。创建会话后，可以讨论想法、整理文件，或完成具体任务。</p>
            <button class="reader-button primary" type="button" onclick={() => void beginCreate()}
              >开始新对话</button
            >
            <p class="quiet">对话和草稿保存在本机，重启后可以继续。</p>
          {/if}
        </section>{/if}
    </div>
  </main>
  <NewConversationDialog
    bind:this={createDialog}
    {api}
    {workspaces}
    onCreated={(item) => void created(item).catch(report)}
  />
  <ForkConversationDialog
    bind:this={forkDialog}
    {api}
    onCreated={(item) => void created(item).catch(report)}
  />
  <ConversationActions
    bind:this={actionDialog}
    {api}
    onDone={(action, id) => void managed(action, id).catch(report)}
  />
</aside>

<style>
  .article-source {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.6rem;
    padding: 0.65rem 1.5rem;
    border-bottom: 1px solid var(--border);
    background: var(--sidebar);
    font-size: 0.75rem;
    color: var(--muted);
  }
  .article-source div {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    flex: 1;
    min-width: 0;
  }
  .article-source strong {
    color: var(--fg);
    font-weight: 500;
  }
  .article-source span {
    overflow-wrap: anywhere;
  }
  .agent-panel {
    position: fixed;
    inset: 44px 0 0;
    z-index: 60;
    display: grid;
    grid-template-columns: 244px minmax(0, 1fr);
    background: var(--bg);
    color: var(--fg);
    font-family: "Inter Variable", "Noto Sans SC Variable", sans-serif;
  }
  .conversation-content {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }
  .list-scrim {
    position: absolute;
    inset: var(--conversation-header-height) 0 0;
    z-index: 3;
    border: 0;
    background: var(--scrim);
  }
  .conversation-sidebar {
    min-height: 0;
    min-width: 0;
    display: flex;
  }
  .conversation-sidebar :global(.conversations) {
    flex: 1;
  }
  .conversation-main {
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
  }
  .conversation-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.85rem 1.5rem;
    border-bottom: 1px solid var(--border);
    min-height: 65px;
    flex: 0 0 auto;
  }
  .conversation-heading {
    flex: 1;
    min-width: 0;
  }
  h1 {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .conversation-heading p {
    margin: 0.3rem 0 0;
    color: var(--muted);
    font-size: 0.72rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .model-badge {
    font-size: 0.68rem;
    color: var(--muted);
    padding: 0.25rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: 5px;
    max-width: 9rem;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .conversation-menu {
    padding: 0.35rem;
    min-width: 10rem;
  }
  .conversation-menu button {
    display: block;
    width: 100%;
    text-align: left;
    border: 0;
    background: transparent;
  }
  .conversation-menu button:hover {
    background: var(--selected);
  }
  .danger {
    color: var(--danger);
  }
  .list-toggle {
    display: none;
  }
  .return-notes {
    white-space: nowrap;
    font-size: 0.75rem;
  }
  .composer {
    width: calc(100% - 3rem);
    max-width: 46rem;
    align-self: center;
    margin: 0.6rem 1.5rem 1.3rem;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface);
    padding: 0.7rem;
    box-shadow: 0 3px 14px var(--shadow);
  }
  .composer:focus-within {
    border-color: var(--accent);
  }
  textarea {
    display: block;
    width: 100%;
    min-height: 4rem;
    max-height: 12rem;
    resize: vertical;
    field-sizing: content;
    background: transparent;
    color: var(--fg);
    border: 0;
    outline: none;
    padding: 0.3rem;
    font: inherit;
    font-size: 0.86rem;
    line-height: 1.7;
  }
  .composer-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .composer-hint {
    flex: 1;
    color: var(--muted);
    font-size: 0.65rem;
  }
  .panel-error,
  .archived-notice,
  .run-notice {
    display: flex;
    align-items: center;
    gap: 0.65rem;
    padding: 0.6rem 1.5rem;
    font-size: 0.78rem;
    line-height: 1.5;
  }
  .panel-error {
    color: var(--danger);
    background: var(--sidebar);
  }
  .panel-error span,
  .archived-notice span {
    flex: 1;
    overflow-wrap: anywhere;
  }
  .archived-notice,
  .run-notice {
    color: var(--muted);
    border-bottom: 1px solid var(--border);
  }
  .run-notice {
    align-items: flex-start;
    flex-direction: column;
    gap: 0.2rem;
  }
  .storage-issues {
    color: var(--danger);
    font-size: 0.75rem;
    padding: 0.6rem 1.5rem;
  }
  .storage-issues p {
    overflow-wrap: anywhere;
  }
  .settings-page {
    min-height: 0;
    overflow: auto;
    padding: 1.5rem;
  }
  .settings-page :global(.model-settings) {
    max-width: 64rem;
    margin: 0 auto;
  }
  .agent-empty {
    margin: auto;
    padding: 2rem;
    max-width: 35rem;
    line-height: 1.8;
  }
  .empty-symbol {
    display: block;
    color: var(--accent);
    font-size: 2rem;
  }
  .agent-empty h2 {
    margin: 0.5rem 0;
    font-size: 1.5rem;
    font-weight: 500;
  }
  .agent-empty p {
    color: var(--muted);
    font-size: 0.86rem;
  }
  .agent-empty .quiet {
    font-size: 0.73rem;
    margin-top: 1.2rem;
  }
  .browser-region {
    padding: 0 1.5rem;
    max-height: 25%;
    overflow: auto;
  }
  .terminal-drawer {
    max-height: 40%;
    overflow: auto;
    padding: 0.5rem 1.5rem;
    border-top: 1px solid var(--border);
  }
  .terminal-drawer > header {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    margin-bottom: 0.5rem;
    font-size: 0.8rem;
  }
  .terminal-drawer > header strong {
    margin-right: auto;
  }
  .terminal-drawer select {
    max-width: 12rem;
    background: var(--bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 5px;
    font: inherit;
  }
  .terminal-drawer p {
    font-size: 0.75rem;
    color: var(--muted);
  }
  @media (max-width: 800px) {
    .agent-panel {
      grid-template-columns: minmax(0, 1fr);
    }
    .conversation-sidebar {
      display: none;
      position: absolute;
      left: 0;
      top: var(--conversation-header-height);
      bottom: 0;
      width: min(280px, 80vw);
      z-index: 4;
      box-shadow: 12px 0 30px var(--shadow);
    }
    .conversation-sidebar.shown {
      display: flex;
    }
    .list-toggle {
      display: block;
    }
    .conversation-header {
      padding: 0.75rem;
      gap: 0.5rem;
    }
    .model-badge {
      display: none;
    }
    .composer {
      width: calc(100% - 1.5rem);
      margin: 0.5rem 0.75rem 0.75rem;
    }
    .composer-hint {
      font-size: 0.6rem;
    }
  }
</style>
