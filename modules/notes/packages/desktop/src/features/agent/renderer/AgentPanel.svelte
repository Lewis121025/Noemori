<script lang="ts">
  import { onMount, onDestroy, tick } from "svelte";
  import { SvelteMap } from "svelte/reactivity";
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
  import ConversationTerminal from "./ConversationTerminal.svelte";
  import ReferenceCards from "./ReferenceCards.svelte";
  import AttachmentCards from "./AttachmentCards.svelte";
  import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, type AgentAttachment } from "../shared/attachments";
  import { addReference, parseReferences, REFERENCE_MIME, type AgentReference } from "../shared/references";
  import QueuedMessages from "./QueuedMessages.svelte";
  import { newConversationQueue } from "../shared/queue";
  import AgentBrowser from "./AgentBrowser.svelte";
  import AgentUi from "./AgentUi.svelte";
  import { createCompositionGuard } from "../../reader/shared/composition";
  import { LIBRARY_ENTRIES_MIME, parseLibraryEntriesDrag } from "../../reader/shared/file-drag";
  let {
    api,
    close,
    openLink,
    selected = $bindable<string | null>(null),
    articleFilter = $bindable<{ root: string; path: string } | null>(null),
    beforeSend,
    onOpenArticle,
    onOpenReference,
    onList,
    onConfigure,
    modelCatalogVersion = 0,
  }: {
    selected?: string | null;
    articleFilter?: { root: string; path: string } | null;
    beforeSend?: () => Promise<void>;
    onOpenReference?: (reference: AgentReference) => Promise<void>;
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
  let queue = $state(newConversationQueue());
  let prompt = $state("");
  let savedDraft = $state("");
  let references = $state<AgentReference[]>([]);
  let savedReferences = $state("[]");
  let attachments = $state<AgentAttachment[]>([]);
  let savedAttachmentIds = $state("[]");
  /** 导入阶段的附件列表尚未合并；文字保存只能保留主进程已导入的附件。 */
  type AttachmentImportPhase = "saving" | "importing";
  const attachmentImports = new SvelteMap<string, AttachmentImportPhase>();
  let draggingFiles = $state(false);
  const uploading = $derived(Boolean(current && attachmentImports.has(current.id)));
  let dragDepth = $state(0);
  let referenceNotice = $state("");
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
  // 连接设置只控制展示；内置工具的调用与可用性由运行时负责。
  let uiSettingsShown = $state(false);
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
  const panelId = $props.id();
  const workspaces = $derived([
    ...new Set(items.flatMap((item) => (item.workspace ? [item.workspace] : []))),
  ]);
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
  function reportFor(id: string, cause: unknown): void {
    if (selected === id) report(cause);
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
    const [snapshot, pending] = await Promise.all([api.snapshot(id), api.queueGet(id)]);
    if (live && selected === id && selection === selectionVersion && version === refreshVersion) {
      current = snapshot;
      queue = pending;
    }
  }

  /** 关闭面板、切换会话和退出窗口都先提交当前草稿，失败时保留界面与输入。 */
  export async function flushDraft(): Promise<void> {
    if (draftTimer !== undefined) clearTimeout(draftTimer);
    draftTimer = undefined;
    const item = current;
    const encoded = JSON.stringify(references);
    const fileIds = attachments.map((file) => file.id), filesKey = JSON.stringify(fileIds);
    if (!item || (prompt === savedDraft && encoded === savedReferences && filesKey === savedAttachmentIds)) return;
    const value = prompt;
    const quoted = $state.snapshot(references);
    if (attachmentImports.get(item.id) === "importing") await api.saveDraft(item.id, value, quoted);
    else if (fileIds.length || savedAttachmentIds !== "[]") await api.saveDraft(item.id, value, quoted, fileIds);
    else if (quoted.length) await api.saveDraft(item.id, value, quoted);
    else await api.saveDraft(item.id, value);
    if (current?.id === item.id && prompt === value && JSON.stringify(references) === encoded && JSON.stringify(attachments.map((file) => file.id)) === filesKey) {
      savedDraft = value;
      savedReferences = encoded;
      savedAttachmentIds = filesKey;
    }
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
      const [snapshot, pending] = await Promise.all([api.snapshot(id), api.queueGet(id)]);
      if (!live || selectionVersion !== version) return false;
      selected = id;
      articleFilter = null;
      current = snapshot;
      queue = pending;
      prompt = snapshot.draft;
      savedDraft = prompt;
      references = snapshot.draftReferences ?? [];
      savedReferences = JSON.stringify(references);
      attachments = snapshot.draftAttachments ?? [];
      savedAttachmentIds = JSON.stringify(attachments.map((file) => file.id));
      dragDepth = 0;
      referenceNotice = "";
      terminalShown = false;
      uiSettingsShown = false;
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
  async function send(intent: "next" | "steer" = "next"): Promise<void> {
    const item = current;
    const value = prompt;
    const quoted = $state.snapshot(references);
    const quotedKey = JSON.stringify(quoted);
    const fileIds = attachments.map((file) => file.id), filesKey = JSON.stringify(fileIds);
    const run = item?.run;
    const running = run?.status === "running";
    if (
      !item ||
      item.archived ||
      (!running && !modelAvailable) ||
      sending ||
      uploading ||
      loading ||
      composition.active ||
      stoppingIds.includes(item.id) ||
      (!value.trim() && !fileIds.length)
    )
      return;
    sending = true;
    error = "";
    try {
      await flushDraft();
      await beforeSend?.();
      if (running && run) {
        if (intent === "steer") {
          if (fileIds.length) await api.steer(item.id, run.id, value, quoted, fileIds);
          else if (quoted.length) await api.steer(item.id, run.id, value, quoted);
          else await api.steer(item.id, run.id, value);
        } else {
          if (fileIds.length) await api.queueAdd(item.id, run.id, value, quoted, fileIds);
          else if (quoted.length) await api.queueAdd(item.id, run.id, value, quoted);
          else await api.queueAdd(item.id, run.id, value);
        }
      } else {
        if (fileIds.length) await api.start(item.id, value, quoted, fileIds);
        else if (quoted.length) await api.start(item.id, value, quoted);
        else await api.start(item.id, value);
      }
      if (selected === item.id && prompt === value && JSON.stringify(references) === quotedKey && JSON.stringify(attachments.map((file) => file.id)) === filesKey) {
        prompt = "";
        savedDraft = "";
        references = [];
        savedReferences = "[]";
        attachments = [];
        savedAttachmentIds = "[]";
        messagesView?.showLatest();
      }
    } catch (cause) {
      reportFor(item.id, cause);
    } finally {
      sending = false;
      await refresh(item.id).catch((cause) => reportFor(item.id, cause));
      await tick();
      // 发送按钮禁用后焦点可能落回页面；用户已经转向别处时不抢回焦点。
      if (
        selected === item.id &&
        (document.activeElement === document.body ||
          document.activeElement?.matches(".composer textarea, .composer-send"))
      )
        focusComposer(item.id);
    }
  }
  /**
   * @param reference 点击或拖拽时捕获的原文及来源；空工作区创建独立对话。
   * @returns 引用随当前草稿保存后兑现，仅在仍是原对话时交还输入焦点。
   * @throws 引用无效、目标归档、正在接受输入或保存失败时拒绝，不调用模型或修改原文。
   */
  export async function addSelectedReference(reference: AgentReference): Promise<void> {
    if (sending || loading) throw new Error("对话正在准备，请稍后添加引用");
    const checked = parseReferences([reference])[0]!;
    if (!current) {
      const sourceSelection = selectionVersion;
      const item = await api.create(null, "新对话");
      // 新建等待期间用户已选择其他对话时，只保存本次引用，不用迟到结果抢回界面。
      if (selectionVersion !== sourceSelection) {
        await api.saveDraft(item.id, "", [checked]);
        await refreshList();
        return;
      }
      await created(item);
    }
    const item = current;
    if (!item || item.archived) throw new Error("请先恢复对话，再添加引用");
    const next = addReference(references, checked);
    referenceNotice = next === references ? "此内容已在引用中" : "已添加引用";
    references = next;
    await flushDraft();
    await tick();
    focusComposer(item.id);
  }
  function removeReference(id: string): void {
    references = references.filter((reference) => reference.id !== id);
    referenceNotice = "已移除引用";
    draftChanged();
    if (current) focusComposer(current.id);
  }
  function acceptsDrop(transfer: DataTransfer | null): boolean {
    return Boolean(
      transfer &&
      (transfer.types.includes("Files") || transfer.types.includes(LIBRARY_ENTRIES_MIME) || transfer.types.includes(REFERENCE_MIME) || transfer.types.includes("text/plain")),
    );
  }
  function enterComposerDrop(event: DragEvent): void {
    if (!acceptsDrop(event.dataTransfer) || sending || loading || uploading) return;
    event.preventDefault();
    draggingFiles = Boolean(event.dataTransfer?.types.some((type) => type === "Files" || type === LIBRARY_ENTRIES_MIME));
    dragDepth += 1;
  }
  function overComposerDrop(event: DragEvent): void {
    if (!acceptsDrop(event.dataTransfer)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = sending || loading || uploading ? "none" : "copy";
  }
  async function dropIntoComposer(event: DragEvent): Promise<void> {
    dragDepth = 0;
    if (!acceptsDrop(event.dataTransfer)) return;
    event.preventDefault();
    if (sending || loading || uploading) return;
    const transfer = event.dataTransfer;
    if (!transfer) return;
    if (transfer.files.length) {
      await uploadBrowserFiles(Array.from(transfer.files));
      return;
    }
    try {
      if (transfer.types.includes(LIBRARY_ENTRIES_MIME)) {
        // 浏览器只在 drop 事件内开放载荷；必须先捕获身份，再等待草稿保存。
        const source = parseLibraryEntriesDrag(JSON.parse(transfer.getData(LIBRARY_ENTRIES_MIME)));
        await receiveAttachments((id) => api.attachmentsFromLibrary(id, source));
        return;
      }
      const structured = transfer.getData(REFERENCE_MIME);
      const reference = structured
        ? parseReferences([JSON.parse(structured)])[0]!
        : { id: crypto.randomUUID(), text: transfer.getData("text/plain"), source: null };
      await addSelectedReference(reference);
    } catch (cause) {
      report(cause);
    }
  }

  /** 导入回执只作用于捕获的会话；主进程已保存副本，离开后由该会话自行恢复草稿。 */
  async function receiveAttachments(select: (id: string) => Promise<AgentAttachment[]>): Promise<void> {
    const item = current;
    if (!item || item.archived || loading || sending || attachmentImports.has(item.id)) return;
    attachmentImports.set(item.id, "saving");
    error = "";
    try {
      await flushDraft();
      attachmentImports.set(item.id, "importing");
      const files = await select(item.id);
      if (!live || current?.id !== item.id || !files.length) return;
      const known = new Set(attachments.map((file) => file.id));
      attachments = [...attachments, ...files.filter((file) => !known.has(file.id))];
      attachmentImports.set(item.id, "saving");
      await flushDraft();
      if (current?.id === item.id) referenceNotice = `已添加 ${files.length} 个附件`;
      if (current?.id === item.id && (document.activeElement === document.body || document.activeElement?.matches(".composer textarea, .composer-attachment"))) focusComposer(item.id);
    } catch (cause) {
      reportFor(item.id, cause);
    } finally {
      attachmentImports.delete(item.id);
    }
  }
  async function uploadBrowserFiles(files: File[]): Promise<void> {
    await receiveAttachments(async (id) => {
      if (files.length > MAX_ATTACHMENTS || files.some((file) => file.size > MAX_ATTACHMENT_BYTES))
        throw new Error("一次最多八个附件，每个不能超过 25 MiB");
      const data = await Promise.all(files.map(async (file) => ({ name: file.name || "粘贴图片.png", bytes: new Uint8Array(await file.arrayBuffer()) })));
      return api.attachmentsUpload(id, data);
    });
  }
  function removeAttachment(id: string): void {
    attachments = attachments.filter((file) => file.id !== id);
    draftChanged();
    if (current) focusComposer(current.id);
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
      reportFor(item.id, cause);
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
      reportFor(item.id, cause);
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
      reportFor(id, cause);
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
  async function changeQueue(action: () => Promise<unknown>, id: string): Promise<void> {
    await action();
    await refresh(id);
  }
  // 收起会移除当前控件，显式交还输入焦点，避免下一次快捷键落到助手之外。
  function hideTerminal(): void {
    terminalShown = false;
    if (current) focusComposer(current.id);
  }
  async function toggleTerminal(): Promise<void> {
    if (terminalShown) {
      hideTerminal();
      return;
    }
    terminalShown = true;
    await tick();
    panelElement.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea")?.focus();
  }
</script>

<svelte:window ondragend={() => (dragDepth = 0)} onkeydown={(event) => {
  if ((event.ctrlKey || event.metaKey) && event.code === "Backquote" && current && event.target instanceof Node && panelElement.contains(event.target)) {
    event.preventDefault();
    void toggleTerminal();
  }
}} />

<aside class="agent-panel" aria-label="工作区助手" bind:this={panelElement}>
  <main class="conversation-main">
    <header class="conversation-header">
      <div class="conversation-heading">
        <h1 title={current?.title ?? "工作区助手"}>{current?.title ?? "工作区助手"}</h1>
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
          title="对话操作"
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
          <button
            class="reader-button"
            type="button"
            aria-label="查看会话终端"
            aria-pressed={terminalShown}
            title="Cmd/Ctrl+`"
            onclick={() => {
              moreMenu?.hidePopover();
              void toggleTerminal();
            }}>{terminalShown ? "收起终端" : "查看终端"}</button
          >
          <button class="reader-button" type="button" onclick={() => void beginFork()}
            >分叉对话…</button
          >
          <button class="reader-button" type="button" onclick={() => void manage("rename")}
            >重命名对话</button
          >
          <button
            class="reader-button"
            type="button"
            onclick={() => {
              uiSettingsShown = true;
              moreMenu?.hidePopover();
            }}>浏览器连接与权限…</button
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
        title="关闭助手"
        disabled={closing}
        onclick={() => void closePanel()}
        ><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" /></svg
        ></button
      >
    </header>
    <div class="conversation-content" aria-busy={loading}>
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
            <span>此对话已归档</span><button
              class="reader-button"
              type="button"
              onclick={() => void restore()}>恢复对话</button
            >
          </div>{/if}
        {#key current.id}<ConversationMessages
            {api}
            bind:this={messagesView}
            onFork={(turnId) => void beginFork(turnId)}
            {...onOpenReference ? { onOpenReference } : {}}
            {current}
            {openLink}
            {approving}
            onApprove={(approval, choice) => void decision(approval, choice)}
            onSuggest={!prompt.trim() && !attachments.length && !loading && !sending && !current.archived
              ? (value) => {
                  prompt = value;
                  draftChanged();
                  if (current) focusComposer(current.id);
                }
              : undefined}
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
        <!-- 运行时就绪本身没有可操作内容；控制栏保留实际任务、连接、异常和用户主动打开的设置。 -->
        {#if uiSettingsShown || current.ui.status === "busy" || current.ui.status === "failed" || current.ui.error || current.ui.control || current.ui.connections.length || current.ui.receipts.length}<div
            class="browser-region"
          >
            {#key current.id}<AgentUi
                {api}
                session={current.id}
                ui={current.ui}
                settingsOpen={uiSettingsShown}
              />{/key}
          </div>{/if}
        {#if terminalShown}{#key current.id}<ConversationTerminal
              {api}
              session={current.id}
              terminals={current.terminals}
              archived={current.archived}
              onCreate={openTerminal}
              onHide={hideTerminal}
            />{/key}{/if}
        {#key current.id}
          {@const id = current.id}
          <QueuedMessages
            {queue}
            disabled={current.archived || loading}
            onRemove={(messageId) => changeQueue(() => api.queueRemove(id, messageId), id)}
            onPause={(paused) => changeQueue(() => api.queuePause(id, paused), id)}
          />
        {/key}
        {#if !current.archived}<form
            class="composer"
            class:drop-active={dragDepth > 0}
            ondragenter={enterComposerDrop}
            ondragover={overComposerDrop}
            ondragleave={() => (dragDepth = Math.max(0, dragDepth - 1))}
            ondrop={(event) => void dropIntoComposer(event)}
            use:composition.bind
            onsubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <ReferenceCards {references} disabled={sending || loading} onRemove={removeReference} {...onOpenReference ? { onOpen: onOpenReference } : {}} />
            {#key current.id}<AttachmentCards {api} session={current.id} files={attachments} disabled={sending || loading || uploading} onRemove={removeAttachment} />{/key}
            <span class="reference-notice" role="status">{referenceNotice}</span>
            {#if uploading}<span class="attachment-status" role="status">正在添加附件…</span>{/if}
            {#if dragDepth > 0}<div class="reference-drop" aria-hidden="true"><strong>{draggingFiles ? "松开即可添加附件" : "松开即可添加引用"}</strong><span>{draggingFiles ? "保留原文件 · 可预览和移除" : "添加到当前对话"}</span></div>{/if}
            <textarea
              bind:value={prompt}
              aria-label="Agent 用户任务"
              aria-describedby={`${panelId}-composer-hint`}
              placeholder="发送消息…"
              rows="1"
              disabled={loading || sending}
              oninput={draftChanged}
              onpaste={(event) => {
                const files = Array.from(event.clipboardData?.files ?? []);
                if (!files.length) return;
                event.preventDefault();
                void uploadBrowserFiles(files);
              }}
              onkeydown={(event) => {
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.isComposing &&
                  event.keyCode !== 229
                ) {
                  event.preventDefault();
                  void send(event.ctrlKey || event.metaKey ? "steer" : "next");
                }
              }}
            ></textarea>
            <div class="composer-actions">
              <button class="reader-button composer-attachment" type="button" aria-label="添加附件" title="添加文件或图片" disabled={loading || sending || uploading} onclick={() => void receiveAttachments((id) => api.attachmentsChoose(id))}>
                <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12" /></svg>
              </button>
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
              {#if current.run?.status === "running"}<div class="running-actions">
                <button class="supplement" type="button" aria-label="补充当前任务"
                  title="补充当前任务 · Cmd/Ctrl+Enter · 当前操作结束后接收"
                  disabled={loading || sending || uploading || stoppingIds.includes(current.id) || (!prompt.trim() && !attachments.length)}
                  onclick={() => void send("steer")}>补充</button>
                <button class="reader-button primary composer-send" type="submit" aria-label="排队追问"
                  title="Enter 排队，当前任务完成后发送"
                  disabled={loading || sending || uploading || stoppingIds.includes(current.id) || (!prompt.trim() && !attachments.length)}>
                  <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 5h8M4 10h8M4 15h5M15 11v6m-3-3 3 3 3-3" /></svg>
                </button>
                <button
                  class="reader-button composer-send"
                  type="button"
                  aria-label={stoppingIds.includes(current.id) ? "正在停止…" : "停止生成"}
                  title="停止生成"
                  disabled={stoppingIds.includes(current.id)}
                  onclick={() => void interruptRun()}
                  ><svg viewBox="0 0 20 20" aria-hidden="true"
                    ><rect x="6" y="6" width="8" height="8" rx="1" /></svg
                  ></button
                ></div>
              {:else}<button
                  class="reader-button primary composer-send"
                  type="submit"
                  aria-label={sending ? "正在发送…" : "发送"}
                  title="Enter 发送 · Shift+Enter 换行"
                  disabled={!modelAvailable || loading || sending || uploading || (!prompt.trim() && !attachments.length)}
                  ><svg viewBox="0 0 20 20" aria-hidden="true"
                    ><path d="M10 15V5m-5 5 5-5 5 5" /></svg
                  ></button
                >{/if}
            </div>
          </form>
          <p class="composer-hint" id={`${panelId}-composer-hint`}>
            {current.run?.status === "running"
              ? "Enter 排队 · Cmd/Ctrl + Enter 补充当前任务"
              : !modelAvailable
                ? "选择模型后即可发送"
                : "Enter 发送 · Shift + Enter 换行"}
          </p>{/if}
      {:else if loading}<div class="agent-loading" role="status">正在读取对话…</div>
      {:else}<section class="agent-empty">
          {#if articleFilter}<h2>暂无对话</h2>
            <p>在正文中插入 Agent 对话。</p>
            <button
              class="reader-button primary"
              type="button"
              onclick={() => {
                if (articleFilter)
                  void onOpenArticle?.(articleFilter.root, articleFilter.path, "").catch(report);
              }}>返回文章</button
            >
          {:else}
            <h2>有什么想法？</h2>
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
    --bg: light-dark(#faf9f6, #22211f);
    --surface: light-dark(#ffffff, #2b2a27);
    --fg: light-dark(#302e29, #f0ece5);
    --muted: light-dark(#767167, #b4aea4);
    --border: light-dark(#e7e3db, #423f39);
    --sidebar: light-dark(#f0ede6, #33312c);
    --selected: light-dark(#ece8e0, #3d3932);
    --control-hover: color-mix(in srgb, var(--selected) 65%, transparent);
    --accent: light-dark(#71685b, #c9beb0);
    --accent-fill: light-dark(#34322d, #e8e0d4);
    --accent-text: light-dark(#ffffff, #292620);
    --danger: light-dark(#a84b3c, #eba396);
    --shadow: light-dark(#3028190a, #00000030);
    --shadow-popover:
      0 4px 12px light-dark(rgb(32 28 22 / 6%), rgb(0 0 0 / 18%)),
      0 16px 40px light-dark(rgb(32 28 22 / 10%), rgb(0 0 0 / 30%));
    --radius-control: 8px;
    --radius-panel: 14px;
    --conversation-inset: 20px;
    --conversation-width: 44rem;
    --glass-sheen: none;
    --glass-solid: var(--surface);
    --glass-overlay: var(--surface);
    --glass-control: var(--bg);
    --glass-edge: var(--border);
    /* 浮层阴影会与内沿组合，透明零阴影保留合法的列表值。 */
    --glass-rim: 0 0 0 transparent;
    --glass-overlay-shadow: var(--shadow-popover);
    --glass-filter: none;
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
    background: var(--bg);
  }
  .conversation-header {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 10px var(--conversation-inset);
    border-bottom: 1px solid transparent;
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
    font-weight: 550;
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
    padding: 6px;
    min-width: 10rem;
  }
  .conversation-menu button {
    display: block;
    width: 100%;
    text-align: left;
    border: 0;
    background: transparent;
    font-size: 12px;
    font-weight: 400;
  }
  .conversation-menu button:hover:not(:disabled) {
    background: var(--control-hover);
  }
  .danger {
    color: var(--danger);
  }
  .conversation-icon,
  .return-notes,
  .composer-attachment,
  .composer-send {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    padding: 0;
    flex-shrink: 0;
  }
  .conversation-icon,
  .return-notes,
  .composer-attachment {
    border: 0;
    background: transparent;
    box-shadow: none;
    color: var(--muted);
  }
  .conversation-icon:hover:not(:disabled),
  .return-notes:hover:not(:disabled),
  .composer-attachment:hover:not(:disabled) {
    background: var(--control-hover);
    color: var(--fg);
  }
  .conversation-header .conversation-icon:active:not(:disabled),
  .conversation-header .return-notes:active:not(:disabled),
  .conversation-menu button[aria-pressed="true"] {
    background: var(--selected);
    box-shadow: none;
  }
  .composer-attachment { width: 28px; height: 28px; }
  .attachment-status { display: block; margin-bottom: 6px; font-size: 11px; color: var(--muted); }
  .agent-panel svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .composer-send {
    width: 32px;
    height: 32px;
    border-radius: 10px;
    border: 0;
    box-shadow: none;
    background: var(--selected);
  }
  .composer .composer-send.primary {
    background: var(--accent-fill);
    box-shadow: none;
  }
  .composer .composer-send:disabled {
    background: var(--sidebar);
    color: var(--muted);
    opacity: 1;
  }
  .reference-notice {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
  .reference-drop {
    position: absolute;
    inset: 3px;
    z-index: 1;
    pointer-events: none;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 5px;
    border: 1px dashed var(--accent);
    border-radius: 13px;
    background: var(--surface);
    color: var(--fg);
    animation: reference-enter 120ms ease-out;
  }
  .reference-drop strong {
    font-size: 12px;
    font-weight: 550;
  }
  .reference-drop span {
    font-size: 11px;
    color: var(--muted);
  }
  .composer.drop-active {
    border-color: var(--accent);
  }
  @keyframes reference-enter {
    from {
      opacity: 0;
      transform: scale(0.99);
    }
    to {
      opacity: 1;
      transform: scale(1);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .reference-drop {
      animation: none;
    }
  }
  .composer {
    position: relative;
    width: calc(100% - 2 * var(--conversation-inset));
    box-sizing: border-box;
    max-width: var(--conversation-width);
    align-self: center;
    margin: 12px var(--conversation-inset) 20px;
    border: 1px solid var(--border);
    border-radius: 16px;
    background: var(--surface);
    padding: 12px 10px 9px;
    flex-shrink: 0;
    box-shadow: 0 2px 10px var(--shadow);
    transition: border-color 160ms ease, box-shadow 160ms ease;
  }
  .composer:hover {
    border-color: color-mix(in srgb, var(--accent) 16%, var(--border));
  }
  .composer:focus-within {
    border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
    box-shadow: 0 2px 10px var(--shadow);
  }
  textarea {
    display: block;
    width: 100%;
    box-sizing: border-box;
    min-height: 40px;
    /* 长输入在小窗口内滚动，给消息与待确认权限保留阅读空间。 */
    max-height: clamp(64px, 16dvh, 160px);
    resize: none;
    field-sizing: content;
    background: transparent;
    color: var(--fg);
    border: 0;
    outline: none;
    padding: 2px 4px 8px;
    font: inherit;
    font-size: 14px;
    line-height: 1.65;
  }
  textarea:focus-visible {
    outline: none;
    box-shadow: none;
  }
  textarea::placeholder {
    color: var(--muted);
    opacity: 1;
  }
  .composer-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    margin-top: 4px;
  }
  .running-actions { display: flex; align-items: center; gap: 5px; margin-left: auto; }
  .supplement { border: 0; border-radius: 6px; background: transparent; color: var(--muted); font: inherit; font-size: 11px; padding: 5px 7px; cursor: pointer; }
  .supplement:hover { background: var(--selected); color: var(--fg); }
  .supplement:disabled { opacity: 0.45; cursor: default; }
  .composer-hint {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
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
    margin: auto var(--conversation-inset);
    padding: 0 0 clamp(24px, 8dvh, 72px);
    max-width: var(--conversation-width);
    line-height: 1.8;
    text-align: left;
  }
  .agent-empty h2 {
    margin: 0 0 24px;
    font-size: 30px;
    font-weight: 450;
    line-height: 1.4;
    font-family: "Noto Serif SC Variable", serif;
  }
  .agent-empty p {
    color: var(--muted);
    font-size: 0.86rem;
  }
  .agent-loading {
    margin: auto;
    color: var(--muted);
    font-size: 13px;
  }
  .browser-region {
    padding: 0 12px;
    max-height: 25%;
    overflow: auto;
  }
  .conversation-main {
    flex: 1;
  }
  @media (max-height: 560px) {
    textarea {
      max-height: 64px;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .composer {
      transition: none;
    }
  }
</style>
