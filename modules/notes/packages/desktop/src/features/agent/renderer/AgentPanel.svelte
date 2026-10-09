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
  import ConversationMessages from "./ConversationMessages.svelte";
  import ConversationActions, { type ConversationAction } from "./ConversationActions.svelte";
  import NewConversationDialog from "./NewConversationDialog.svelte";
  import ConversationModel from "./ConversationModel.svelte";
  import AgentTerminal from "./AgentTerminal.svelte";
  import AgentBrowser from "./AgentBrowser.svelte";
  import AgentUi from "./AgentUi.svelte";
  import { createCompositionGuard } from "../../reader/shared/composition";
  let {
    api,
    close,
    openLink,
    selected = $bindable<string | null>(null),
    articleFilter = $bindable<{ root: string; path: string } | null>(null),
    beforeSend,
    onOpenArticle,
    onList,
    onConfigure,
    modelCatalogVersion = 0,
  }: {
    selected?: string | null;
    articleFilter?: { root: string; path: string } | null;
    beforeSend?: () => Promise<void>;
    onOpenArticle?: (root: string, path: string, markerId: string) => Promise<void>;
    onList?: (items: AgentConversationInfo[]) => void;
    onConfigure?: () => void;
    modelCatalogVersion?: number;
    api: AgentApi;
    close: () => void;
    openLink: (url: string) => Promise<void>;
  } = $props();
  let items = $state<AgentConversationInfo[]>([]);
  let panelElement: HTMLElement;
  let current = $state<AgentConversation | null>(null);
  let prompt = $state("");
  let savedDraft = $state("");
  let error = $state("");
  let issues = $state<string[]>([]);
  let modelAvailable = $state(false);
  let loading = $state(true);
  let sending = $state(false);
  let stoppingIds = $state<string[]>([]);
  let continuingIds = $state<string[]>([]);
  let approving = $state(false);
  let closing = $state(false);
  let terminalShown = $state(false);
  let uiShown = $state(false);
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
  let toolsMenu: HTMLDivElement | undefined = $state();
  const panelId = $props.id();
  const workspaces = $derived([
    ...new Set(items.flatMap((item) => (item.workspace ? [item.workspace] : []))),
  ]);
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
  /** 读取目录投影并丢弃迟到结果；供库加载完成后显式刷新。 */
  export async function refreshList(): Promise<void> {
    const version = ++listVersion;
    const result = await api.list();
    if (!live || version !== listVersion) return;
    // 流式消息不改变导航元数据时保留数组身份，避免每个 token 重建整个笔记库目录。
    if (JSON.stringify(items) !== JSON.stringify(result.items)) items = result.items;
    issues = result.issues;
    onList?.(items);
    // 首次有效列表负责恢复，过期启动响应不能提前结束恢复，也不能覆盖用户主动选择。
    if (selectionVersion === 0) {
      const first =
        items.find((item) => item.id === selected) ??
        items.find(
          (item) =>
            !item.archived &&
            (!articleFilter ||
              (item.workspace === articleFilter.root && item.article?.path === articleFilter.path)),
        );
      if (first) await selectConversation(first.id);
    }
  }
  async function refresh(id: string): Promise<void> {
    await refreshList();
    if (selected !== id) return;
    if (!items.some((item) => item.id === id)) {
      selectionVersion += 1;
      selected = null;
      current = null;
      prompt = "";
      savedDraft = "";
      return;
    }
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
  /** 切换在草稿提交与快照读取成功后才发布身份，失败时保留原会话。 */
  export async function selectConversation(id: string): Promise<boolean> {
    if (current?.id === id) return true;
    const version = ++selectionVersion;
    loading = true;
    error = "";
    try {
      await flushDraft();
      const snapshot = await api.snapshot(id);
      if (!live || selectionVersion !== version) return false;
      selected = id;
      articleFilter = null;
      current = snapshot;
      prompt = snapshot.draft;
      savedDraft = prompt;
      terminalShown = false;
      uiShown = false;
      terminalId = null;
      return true;
    } catch (cause) {
      report(cause);
      return false;
    } finally {
      if (live && selectionVersion === version) loading = false;
    }
  }
  async function initialize(): Promise<void> {
    try {
      await refreshList();
    } catch (cause) {
      report(cause);
    } finally {
      if (live && selectionVersion === 0) loading = false;
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
    await selectConversation(id);
    await tick();
    if (selected === id && turnId) messagesView?.focusTurn(turnId);
  }
  /** 新建只打开名称与可选关联表单；独立入口不继承另一条对话的目录。 */
  export async function createConversation(directory: string | null = null): Promise<void> {
    try {
      await flushDraft();
      await createDialog.open(directory);
    } catch (cause) {
      report(cause);
    }
  }
  async function created(item: AgentConversation): Promise<void> {
    await refreshList();
    if (await selectConversation(item.id)) {
      await tick();
      focusComposer(item.id);
    }
  }
  /** 显式进入对话后交还输入焦点；迟到的其他会话请求不得抢占当前输入。 */
  export function focusComposer(id: string): void {
    if (current?.id === id)
      panelElement.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus();
  }
  /** 所有收起入口共用保存门禁；失败抛出，调用方必须保留当前面板。 */
  export async function prepareToHide(): Promise<boolean> {
    await flushDraft();
    await api.flush();
    return true;
  }
  async function closePanel(): Promise<void> {
    if (closing) return;
    closing = true;
    try {
      if (await prepareToHide()) close();
    } catch (cause) {
      report(cause);
    } finally {
      closing = false;
    }
  }
  async function send(): Promise<void> {
    const item = current;
    if (
      !item ||
      item.archived ||
      !modelAvailable ||
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
      !modelAvailable ||
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
    if (action === "remove" && selected === id) {
      selectionVersion += 1;
      selected = null;
      current = null;
      prompt = "";
      savedDraft = "";
    }
    await refreshList();
    if (selected === id) await refresh(id);
  }
  /** 统一树的管理入口捕获目标，不因右键另一条对话而切换正在编辑的草稿。 */
  export async function manageConversation(
    id: string,
    action: ConversationAction | "fork" | "restore",
  ): Promise<void> {
    await flushDraft();
    const item = await api.snapshot(id);
    if (action === "restore") {
      await api.archive(id, false);
      await refresh(id);
    } else if (action === "fork") await forkDialog.open(item, null);
    else await actionDialog.open(action, item);
  }
  /** 文中入口复用右栏；无会话的文章显示空态，不借用其他文章的对话。 */
  export async function openArticleConversation(
    id: string | null,
    article: { root: string; path: string },
  ): Promise<boolean> {
    if (id) return selectConversation(id);
    await refreshList();
    const first = items.find(
      (item) =>
        !item.archived &&
        item.workspace === article.root &&
        item.article?.path === article.path &&
        !item.article.removed,
    );
    if (first) return selectConversation(first.id);
    await flushDraft();
    selectionVersion += 1;
    articleFilter = article;
    selected = null;
    current = null;
    prompt = "";
    savedDraft = "";
    loading = false;
    return true;
  }
  async function restore(): Promise<void> {
    if (!current) return;
    const id = current.id;
    try {
      await api.archive(id, false);
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

<aside class="agent-panel" aria-label="工作区助手" bind:this={panelElement}>
  <main class="conversation-main">
    <header class="conversation-header">
      <div class="conversation-heading">
        <h1>{current?.title ?? "工作区助手"}</h1>
        {#if current?.workspace}<p title={current.workspace}>
            {current.workspace.split(/[\\/]/).at(-1) || current.workspace}
          </p>{/if}
      </div>
      <button
        class="reader-button conversation-icon"
        type="button"
        aria-label="新建对话"
        title="新建对话"
        onclick={() => void createConversation()}
        ><svg viewBox="0 0 20 20" aria-hidden="true"
          ><path d="M10 4H4v12h12v-6M9 11l1-4 6-6 3 3-6 6-4 1Z" /></svg
        ></button
      >
      {#if current}
        <button
          class="reader-button conversation-icon"
          type="button"
          popovertarget="conversation-menu"
          aria-label="对话操作"
          ><svg viewBox="0 0 20 20" aria-hidden="true"
            ><path d="M4 10h.01M10 10h.01M16 10h.01" stroke-width="3" /></svg
          ></button
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
        onclick={() => void closePanel()}>×</button
      >
    </header>
    <div class="conversation-content">
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
                .then(() => (selected ? refresh(selected) : refreshList()))
                .catch(report)}>重试保存</button
          >
        </div>{/if}
      {#if current}
        {#if current.article && current.workspace}<div class="article-source">
            {#if onOpenArticle}<button
                class="article-link"
                type="button"
                title={`${current.article.path}${current.article.line ? ` · 第 ${current.article.line} 行` : ""}`}
                disabled={current.article.status === "article-missing" ||
                  current.article.status === "unavailable"}
                onclick={() => {
                  const item = current;
                  if (item?.article && item.workspace)
                    void onOpenArticle?.(
                      item.workspace,
                      item.article.path,
                      item.article.markerId,
                    ).catch(report);
                }}
                ><svg viewBox="0 0 20 20" aria-hidden="true"
                  ><path d="M5 3h7l3 3v11H5zM12 3v4h3M8 10h4M8 13h4" /></svg
                ><span>{current.article.title}</span></button
              >
            {:else}<strong>{current.article.title}</strong>{/if}
            {#if current.article.status === "located"}<span
                class="article-location"
                title={current.article.heading ?? "正文"}>第 {current.article.line} 行</span
              >
            {:else}<span class="article-location"
                >{current.article.error ??
                  (current.article.status === "article-missing"
                    ? "来源已移除"
                    : current.article.status === "ambiguous"
                      ? "入口重复"
                      : "入口已移除")}</span
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
                disabled={!modelAvailable ||
                  loading ||
                  sending ||
                  stoppingIds.includes(current.id) ||
                  continuingIds.includes(current.id)}
                onclick={() => void continueRun()}
                >{continuingIds.includes(current.id) ? "正在继续…" : "继续任务"}</button
              >
            {/if}
          </div>{/if}
        {#if current.browser.status !== "idle"}<div class="browser-region">
            {#key current.id}<AgentBrowser
                {api}
                session={current.id}
                browser={current.browser}
              />{/key}
          </div>{/if}
        {#if uiShown || current.ui.status !== "idle" || current.ui.connections.length || current.ui.receipts.length}<div
            class="browser-region"
          >
            {#key current.id}<AgentUi {api} session={current.id} ui={current.ui} />{/key}
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
              placeholder="聊聊你的想法，或交给助手一件事…"
              rows="1"
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
                class="reader-button composer-tool"
                type="button"
                aria-label="对话工具"
                title="对话工具"
                popovertarget={`${panelId}-tools`}
                ><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12" /></svg
                ></button
              >
              <div
                id={`${panelId}-tools`}
                popover="auto"
                class="reader-popover tools-menu"
                bind:this={toolsMenu}
              >
                <button
                  type="button"
                  aria-pressed={terminalShown}
                  onclick={() => {
                    terminalShown = !terminalShown;
                    toolsMenu?.hidePopover();
                  }}
                  ><svg viewBox="0 0 20 20" aria-hidden="true"
                    ><path d="m4 5 5 5-5 5M11 15h5" /></svg
                  >终端</button
                >
                <button
                  type="button"
                  aria-pressed={uiShown}
                  onclick={() => {
                    uiShown = !uiShown;
                    toolsMenu?.hidePopover();
                  }}
                  ><svg viewBox="0 0 20 20" aria-hidden="true"
                    ><rect x="3" y="3" width="14" height="11" rx="2" /><path
                      d="M7 17h6M10 14v3"
                    /></svg
                  >浏览器与应用</button
                >
              </div>
              {#key current.id}<ConversationModel
                  {api}
                  conversationId={current.id}
                  selection={current.modelSelection}
                  running={current.run?.status === "running"}
                  bind:available={modelAvailable}
                  catalogVersion={modelCatalogVersion}
                  configure={() => onConfigure?.()}
                  changed={(selection) => {
                    if (!current) return;
                    refreshVersion += 1;
                    current.modelSelection = selection;
                    if (current.run?.status !== "running") current.model = selection.modelId;
                  }}
                />{/key}
              {#if current.run?.status === "running"}<button
                  class="reader-button composer-send"
                  type="button"
                  aria-label={stoppingIds.includes(current.id) ? "正在停止…" : "停止生成"}
                  title="停止生成"
                  disabled={stoppingIds.includes(current.id)}
                  onclick={() => void interruptRun()}
                  ><svg viewBox="0 0 20 20" aria-hidden="true"
                    ><rect x="6" y="6" width="8" height="8" rx="1" /></svg
                  ></button
                >
              {:else}<button
                  class="reader-button primary composer-send"
                  type="submit"
                  aria-label={sending ? "正在发送…" : "发送"}
                  title="Enter 发送 · Shift+Enter 换行"
                  disabled={!modelAvailable || loading || sending || !prompt.trim()}
                  ><svg viewBox="0 0 20 20" aria-hidden="true"
                    ><path d="M10 15V5m-5 5 5-5 5 5" /></svg
                  ></button
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
            <h2>Agent</h2>
            <p>从笔记库选择对话，或创建新对话。</p>
            <button
              class="reader-button primary"
              type="button"
              onclick={() => void createConversation()}>开始新对话</button
            >
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
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    background: var(--sidebar);
    font-size: 0.75rem;
    color: var(--muted);
  }
  .article-link {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    min-width: 0;
    padding: 0;
    border: 0;
    background: transparent;
    font: inherit;
    text-align: left;
    color: var(--fg);
    cursor: pointer;
  }
  .article-link span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .article-link svg {
    flex-shrink: 0;
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
  }
  .article-link:disabled {
    cursor: default;
    color: var(--muted);
  }
  .article-location {
    font-size: 11px;
  }
  .agent-panel {
    /* 对话是阅读内容层，局部配色不继承外层深色文件栏，也不影响工作区其他区域。 */
    --bg: light-dark(#fafbf8, #222722);
    --surface: light-dark(#ffffff, #272e28);
    --fg: light-dark(#2d3830, #e6ece4);
    --muted: light-dark(#657268, #aab9ac);
    --border: light-dark(#e0e7dd, #3c493e);
    --sidebar: light-dark(#f0f4ed, #2f3b31);
    --selected: light-dark(#e5eee1, #384c3b);
    --accent: light-dark(#365f43, #b9d6ad);
    --accent-fill: light-dark(#365f43, #b9d6ad);
    --accent-text: light-dark(#ffffff, #203423);
    --danger: light-dark(#aa4238, #efa49c);
    --shadow: light-dark(#233d2414, #00000040);
    --glass-sheen: none;
    --glass-solid: var(--surface);
    --glass-overlay: var(--surface);
    --glass-control: var(--bg);
    --glass-edge: var(--border);
    --glass-rim: none;
    display: flex;
    flex: 1;
    min-height: 0;
    min-width: 0;
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
  .conversation-main {
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    background: var(--surface);
  }
  .conversation-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
    min-height: 52px;
    flex: 0 0 auto;
  }
  .conversation-heading {
    flex: 1;
    min-width: 0;
  }
  h1 {
    margin: 0;
    font-size: 13px;
    font-weight: 500;
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
  .return-notes {
    white-space: nowrap;
    font-size: 0.75rem;
  }
  .conversation-icon,
  .composer-tool,
  .composer-send {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    padding: 0;
    flex-shrink: 0;
  }
  .conversation-icon,
  .composer-tool {
    border: 0;
    background: transparent;
    box-shadow: none;
    color: var(--muted);
  }
  .conversation-icon:hover,
  .composer-tool:hover {
    background: var(--selected);
    color: var(--fg);
  }
  .agent-panel svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .composer-send {
    width: 32px;
    height: 32px;
    border-radius: 50%;
  }
  .composer .composer-send.primary {
    background: var(--accent-fill);
    box-shadow: none;
  }
  .composer-tool {
    width: 28px;
    height: 28px;
    min-width: 28px;
    min-height: 28px;
  }
  .tools-menu {
    position-area: top span-right;
    width: 190px;
  }
  .tools-menu button {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    padding: 8px 10px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--fg);
    font: inherit;
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }
  .tools-menu button:hover,
  .tools-menu button[aria-pressed="true"] {
    background: var(--selected);
  }
  .composer {
    width: calc(100% - 24px);
    box-sizing: border-box;
    max-width: 46rem;
    align-self: center;
    margin: 10px 12px 12px;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface);
    padding: 10px 8px 8px;
  }
  .composer:focus-within {
    border-color: var(--accent);
  }
  textarea {
    display: block;
    width: 100%;
    min-height: 44px;
    max-height: 160px;
    resize: none;
    field-sizing: content;
    background: transparent;
    color: var(--fg);
    border: 0;
    outline: none;
    padding: 4px 6px 8px;
    font: inherit;
    font-size: 0.86rem;
    line-height: 1.55;
  }
  .composer-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 8px;
  }
  .panel-error,
  .archived-notice,
  .run-notice {
    display: flex;
    align-items: center;
    gap: 0.65rem;
    padding: 8px 12px;
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
    padding: 8px 12px;
  }
  .storage-issues p {
    overflow-wrap: anywhere;
  }
  .agent-empty {
    margin: auto;
    padding: 2rem;
    max-width: 35rem;
    line-height: 1.8;
  }
  .agent-empty h2 {
    margin: 0.5rem 0;
    font-size: 18px;
    font-weight: 500;
  }
  .agent-empty p {
    color: var(--muted);
    font-size: 0.86rem;
  }
  .browser-region {
    padding: 0 12px;
    max-height: 25%;
    overflow: auto;
  }
  .terminal-drawer {
    max-height: 40%;
    overflow: auto;
    padding: 8px 12px;
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
  .conversation-main {
    flex: 1;
  }
  .return-notes {
    border: 0;
    padding: 3px 6px;
    background: transparent;
    font-size: 17px;
  }
</style>
