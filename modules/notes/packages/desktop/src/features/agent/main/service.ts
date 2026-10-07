import { branchCheckpoint, relocateCheckpoint, type NativeAgentSession } from "@noemori/agent-node";
import { randomUUID } from "node:crypto";
import type {
  AgentConversation,
  AgentConversationInfo,
  AgentConversationList,
  ConversationForkRequest,
  AgentSnapshot,
  ApprovalReply,
  PublicModelSettings,
  TerminalPage,
} from "../shared/api";
import { canResumeRun } from "../shared/run-actions";
import type { ModelSelection, ProviderCatalog, ProviderUpdate } from "../shared/providers";
import { parseSnapshot, parseTerminalPage, record, text as readText } from "../shared/parse";
import { AgentProviderStore } from "./providers";
import { parsePrivateJson } from "./private-json";
import { ConversationStore, conversationTitle, type ConversationRecord } from "./conversations";
import { createNativeSession } from "./native-session";
import { ArticleLibrary } from "./articles";
import {
  articlePrompt,
  type ArticleConversationRequest,
  type ArticleLocation,
} from "../shared/article";

/** 持久化对话拥有稳定身份；原生运行资源按需建立，归档与删除等待实际停机。 */
export class AgentService {
  private readonly sessions = new Map<string, NativeAgentSession>();
  private readonly records = new Map<string, ConversationRecord>();
  private readonly storageErrors = new Map<string, string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly mutations = new Map<string, Promise<void>>();
  private readonly settings: AgentProviderStore;
  private defaultModel: string | null = null;
  private readonly store: ConversationStore;
  private readonly articles: ArticleLibrary;
  private readonly articleLocations = new Map<string, ArticleLocation>();
  private readonly loadedVaults = new Set<string>();
  private readonly ready: Promise<void>;
  private issues: string[] = [];
  private loadError: Error | null = null;
  private stopping: Promise<void> | null = null;

  /** 绑定窗口服务并读取历史；构造时不启动模型或恢复终端。 */
  constructor(
    private readonly userData: string,
    private readonly launcher: string,
    private readonly changed: (id: string) => void,
  ) {
    this.settings = new AgentProviderStore(userData);
    this.store = new ConversationStore(userData);
    this.articles = new ArticleLibrary(userData);
    this.ready = this.load();
  }

  private async load(): Promise<void> {
    try {
      const loaded = await this.store.load();
      this.issues = loaded.issues;
      for (const item of loaded.records) {
        item.snapshot = resumedSnapshot(item.snapshot);
        this.records.set(item.id, item);
      }
      try {
        this.defaultModel = (await this.settings.public())?.model ?? null;
      } catch (cause) {
        this.issues.push(`供应商配置读取失败：${String(cause)}`);
      }
    } catch (cause) {
      this.loadError = cause instanceof Error ? cause : new Error(String(cause));
      this.issues = [`对话目录读取失败：${this.loadError.message}`];
    }
  }

  /** 设置读取只返回无密钥投影。 */
  settingsGet(): Promise<PublicModelSettings | null> {
    return this.settings.public();
  }
  /** 读取全部供应商的公开配置；不解密，也不启动运行。 */
  providersGet(): Promise<ProviderCatalog> {
    return this.settings.catalog();
  }
  /** 保存连接，所有会话从下一轮读取新配置；保存失败保留上一份配置。 */
  providersSave(settings: ProviderUpdate): Promise<ProviderCatalog> {
    return this.updateProviders(() => this.settings.save(settings));
  }
  /** 删除独立供应商；删除当前选择后暂停新轮启动，已有运行继续完成。 */
  providersRemove(id: string): Promise<ProviderCatalog> {
    return this.updateProviders(() => this.settings.remove(id));
  }
  /** 明确选择所有会话下一轮使用的供应商与模型，不中断当前一轮。 */
  modelSelect(selection: ModelSelection): Promise<ProviderCatalog> {
    return this.updateProviders(() => this.settings.select(selection));
  }
  private async updateProviders(
    operation: () => Promise<ProviderCatalog>,
  ): Promise<ProviderCatalog> {
    await this.ready;
    this.ensureOpen();
    const catalog = await operation();
    this.defaultModel = catalog.active?.modelId ?? null;
    for (const id of this.records.keys()) this.changed(id);
    return catalog;
  }

  /**
   * 确认工作目录和名称后创建；落盘成功才交付，失败回收新建的原生资源。
   * @param workspace 经 IPC 确认的工作目录。
   * @param title 用户输入的会话名称。
   * @returns 具有稳定身份的已保存会话；不发送模型请求。
   * @throws 模型未配置、目录无效或保存失败时拒绝，并回收新资源。
   */
  create(workspace: string, title: string): Promise<AgentConversation> {
    return this.createRecord(workspace, title, null);
  }

  /** 加载已打开库中的文章历史；迁移后重绑工作目录，不启动模型，错误保留原因。 */
  attachVault(root: string): Promise<void> {
    return this.serialize(`vault:${root}`, async () => {
      if (this.loadedVaults.has(root)) return;
      const loaded = await (await this.articles.store(root)).load();
      this.issues.push(...loaded.issues.map((issue) => `${root}：${issue}`));
      for (const item of loaded.records) {
        if (!item.article) {
          this.issues.push(`${item.title}：库内对话缺少文章归属`);
          continue;
        }
        const existing = this.records.get(item.id);
        if (existing && existing.snapshot.workspace !== root) {
          this.issues.push(
            `${item.title}：另一个已打开的库副本含有相同对话，请重启后打开需要的副本`,
          );
          continue;
        }
        try {
          if (item.snapshot.workspace !== root)
            item.checkpoint = await relocateCheckpoint(item.checkpoint, root);
          item.snapshot = { ...resumedSnapshot(item.snapshot), workspace: root };
          this.records.set(item.id, item);
          await this.refreshArticle(item);
        } catch (error) {
          this.issues.push(`${item.title}：文章对话未能恢复，原记录仍保留：${String(error)}`);
        }
      }
      this.loadedVaults.add(root);
    });
  }

  /** 确认名称后创建文章对话；先验证文章已保存，取消创建不会发送模型请求。 */
  async createArticle(request: ArticleConversationRequest): Promise<AgentConversation> {
    await this.attachVault(request.root);
    if ((await this.articles.read(request.root, request.path)) === null)
      throw new Error("请先保存文章，再插入对话");
    return this.createRecord(request.root, request.title, request.path);
  }

  private createRecord(
    workspace: string,
    title: string,
    articlePath: string | null,
  ): Promise<AgentConversation> {
    return this.serialize("create", async () => {
      const name = conversationTitle(title);
      const selected = await this.settings.selected();
      if (selected === null) throw new Error("请先配置供应商并选择默认模型");
      const model = selected.settings;
      this.ensureOpen();
      const id = randomUUID();
      const session = createNativeSession(this.userData, this.launcher, workspace, model, () =>
        this.nativeChanged(id),
      );
      try {
        const now = Date.now();
        const snapshot = { ...parseSnapshot(session.snapshot()), id };
        const item: ConversationRecord = {
          id,
          title: name,
          createdAt: now,
          updatedAt: now,
          archived: false,
          origin: null,
          article:
            articlePath === null
              ? null
              : {
                  path: articlePath,
                  title: articlePath.split("/").at(-1)!.replace(/\.md$/iu, ""),
                  markerId: id,
                },
          draft: "",
          model: model.model,
          snapshot,
          checkpoint: session.checkpoint(),
        };
        const location = await this.articles.location(item);
        await (await this.recordStore(item)).save(item);
        this.records.set(id, item);
        this.sessions.set(id, session);
        if (location) this.articleLocations.set(id, location);
        this.changed(id);
        return this.project(item);
      } catch (error) {
        await session.close();
        throw error;
      }
    });
  }

  /**
   * 从指定轮次复制独立对话，来源会话保持可继续状态；不启动新模型或继承旧资源。
   * @param id 来源会话。
   * @param request 用户确认的名称与分叉轮次；null 表示当前完整内容。
   * @returns 保存成功后的新会话，附有可导航的来源身份。
   * @throws 来源失效、轮次仍在运行、检查点非法或落盘失败时拒绝。
   */
  fork(id: string, request: ConversationForkRequest): Promise<AgentConversation> {
    return this.serialize(id, async () => {
      const source = this.record(id);
      const title = conversationTitle(request.title);
      const current = this.project(source);
      if (request.afterTurnId !== null) {
        const turn = current.turns.find((turn) => turn.run.id === request.afterTurnId);
        if (!turn) throw new Error("分叉轮次不存在或来自早期无边界记录");
        if (turn.run.status === "running")
          throw new Error("此轮尚未结束，请选择较早轮次或分叉当前内容");
      }
      this.capture(id);
      const derived = record(
        parsePrivateJson(
          await branchCheckpoint(source.checkpoint, request.afterTurnId ?? undefined),
          "对话检查点",
        ),
      );
      const nextId = randomUUID();
      const now = Date.now();
      const item: ConversationRecord = {
        id: nextId,
        title,
        createdAt: now,
        updatedAt: now,
        archived: false,
        draft: "",
        origin: { conversationId: source.id, title: source.title, turnId: request.afterTurnId },
        article: source.article ? { ...source.article } : null,
        model: source.model,
        checkpoint: readText(derived, "checkpoint"),
        snapshot: { ...parseSnapshot(JSON.stringify(derived["snapshot"])), id: nextId },
      };
      const location = await this.articles.location(item);
      await (await this.recordStore(item)).save(item);
      this.records.set(nextId, item);
      if (location) this.articleLocations.set(nextId, location);
      this.changed(nextId);
      return this.project(item);
    });
  }

  /**
   * 列表只交付摘要；损坏历史保留在磁盘，错误独立显示。
   * @returns 按最近活动排序的摘要与恢复问题，不向窗口泄露模型私有历史。
   * @throws 服务正在关闭时拒绝。
   */
  async list(): Promise<AgentConversationList> {
    await this.ready;
    this.ensureOpen();
    return {
      items: [...this.records.values()]
        .map((item): AgentConversationInfo => {
          const status = this.sessions.has(item.id)
            ? (parseSnapshot(this.sessions.get(item.id)!.snapshot()).run?.status ?? null)
            : (item.snapshot.run?.status ?? null);
          return {
            id: item.id,
            title: item.title,
            workspace: item.snapshot.workspace,
            model: status === "running" ? item.model : (this.defaultModel ?? "未选择模型"),
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
            archived: item.archived,
            origin: item.origin,
            article: this.articleLocations.get(item.id) ?? null,
            status,
          };
        })
        .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)),
      issues: [...this.issues],
    };
  }

  /**
   * 读取选中对话；仅查看历史不会启动原生资源。
   * @param id 持久化会话标识。
   * @returns 包含独立草稿与存储错误的当前快照。
   * @throws 会话不存在或服务正在关闭时拒绝。
   */
  async snapshot(id: string): Promise<AgentConversation> {
    await this.ready;
    this.ensureOpen();
    const item = this.record(id);
    await this.refreshArticle(item);
    return this.project(item);
  }

  /**
   * 显式发送才恢复运行资源；归档对话必须先恢复，历史工具不自动重放。
   * @param id 目标会话。
   * @param text 本轮用户输入。
   * @returns 原生任务标识；运行开始后的保存错误通过 storageError 呈现。
   * @throws 已归档、输入无效、恢复失败或发送前无法保存时拒绝。
   */
  start(id: string, text: string): Promise<string> {
    return this.serialize(id, () => this.beginRun(this.record(id), text, true));
  }

  /**
   * 中断明确的运行，终态与历史提交完成后才兑现；独立后台终端保持原有生命周期。
   * @param id 目标会话。
   * @param runId 用户看到的运行编号，不能用会话编号替代。
   * @returns 对应运行已结算后兑现；重复中断同一已结束运行是幂等的。
   * @throws 身份已变化、资源关闭、等待超时或原生异常时拒绝。
   */
  cancel(id: string, runId: string): Promise<void> {
    return this.serialize(id, async () => {
      const item = this.record(id);
      if (this.project(item).run?.id !== runId) throw new Error("运行已变化，请刷新后重试");
      const session = this.sessions.get(id);
      if (session) await session.interrupt(runId);
      await this.saveProgress(id);
      this.changed(id);
    });
  }

  /**
   * 继续用户指定的未完成运行，创建新一轮；继续动作不消费输入框中的未发送草稿。
   * @param id 目标会话。
   * @param runId 当前中断或失败的运行编号，用于拒绝重复提交和迟到点击。
   * @returns 新运行编号。
   * @throws 运行已变化、不可继续、已归档或启动失败时拒绝。
   */
  resume(id: string, runId: string): Promise<string> {
    return this.serialize(id, async () => {
      const item = this.record(id);
      const run = this.project(item).run;
      if (run?.id !== runId) throw new Error("运行已变化，请刷新后重试");
      if (!canResumeRun(run)) throw new Error("当前运行尚未停止或已经完成，不能继续");
      return this.beginRun(item, "继续上次未完成的任务。", false);
    });
  }

  private async beginRun(
    item: ConversationRecord,
    text: string,
    consumeDraft: boolean,
  ): Promise<string> {
    if (item.archived) throw new Error("请先恢复已归档的对话");
    const session = await this.activate(item);
    // 先确认历史与草稿可保存，存储故障时不派发模型或工具操作。
    await this.persist(item.id);
    await this.refreshArticle(item);
    const article = this.articleLocations.get(item.id);
    if (article?.status === "unavailable") throw new Error(`无法核对文章内容：${article.error}`);
    // 历史落盘和文章读取都可能等待；紧贴派发边界读取，避免期间保存的新配置被错过。
    const selected = await this.settings.selected();
    if (!selected) throw new Error("请先配置供应商并选择默认模型");
    const run = session.startConfigured(
      JSON.stringify(selected.settings),
      selected.binding,
      text,
      article ? articlePrompt(item.snapshot.workspace, article) : undefined,
    );
    item.model = selected.settings.model;
    if (consumeDraft) item.draft = "";
    item.updatedAt = Date.now();
    // 原生已接受任务，写盘故障通过状态提示，不能伪报发送失败而诱发重复执行。
    await this.saveProgress(item.id);
    this.changed(item.id);
    return run;
  }

  /**
   * 修改对话名称；保存失败保留待保存内容并明确反馈。
   * @param id 目标会话。
   * @param title 新的显示名称。
   * @returns 名称保存后兑现。
   * @throws 名称无效、会话不存在或持久化失败时拒绝。
   */
  rename(id: string, title: string): Promise<void> {
    return this.serialize(id, async () => {
      const item = this.record(id);
      item.title = conversationTitle(title);
      item.updatedAt = Date.now();
      await this.persist(id);
      this.changed(id);
    });
  }

  /**
   * 归档前停止本会话任务与资源；恢复归档只改变列表归属，不调用模型。
   * @param id 目标会话。
   * @param archived 归档或恢复。
   * @returns 停机与元数据保存完成后兑现。
   * @throws 会话不存在、资源关闭或持久化失败时拒绝。
   */
  archive(id: string, archived: boolean): Promise<void> {
    return this.serialize(id, async () => {
      const item = this.record(id);
      if (archived) await this.release(id);
      item.archived = archived;
      await this.persist(id);
      this.changed(id);
    });
  }

  /**
   * 删除必须来自界面确认；停机和磁盘删除成功后才移除记录。
   * @param id 用户已明确确认删除的会话。
   * @returns 资源关闭与记录删除后兑现。
   * @throws 会话不存在、关闭或删除失败时拒绝，保留内存记录。
   */
  remove(id: string): Promise<void> {
    return this.serialize(id, async () => {
      this.record(id);
      await this.release(id);
      this.clearTimer(id);
      await (await this.recordStore(this.record(id))).remove(id);
      this.articleLocations.delete(id);
      this.records.delete(id);
      this.storageErrors.delete(id);
      this.changed(id);
    });
  }

  /**
   * 草稿按对话独立持久化；切换会话不把未发送文本带给另一个工作目录。
   * @param id 所属会话。
   * @param draft 未发送文本，空字符串表示清空。
   * @returns 草稿保存后兑现。
   * @throws 会话不存在、草稿超过限制或保存失败时拒绝。
   */
  saveDraft(id: string, draft: string): Promise<void> {
    return this.serialize(id, async () => {
      if (draft.length > 128 * 1024) throw new Error("消息超过 128 KiB");
      const item = this.record(id);
      item.draft = draft;
      await this.persist(id);
    });
  }

  /**
   * 退出窗口前确认已收到的修改落盘。
   * @returns 当前写入队列与会话保存完成后兑现。
   * @throws 读取或保存失败时拒绝，由调用方保留窗口与用户输入。
   */
  async flush(): Promise<void> {
    await this.ready;
    if (this.loadError) throw this.loadError;
    await Promise.all(this.mutations.values());
    await this.settings.flush();
    await Promise.all([...this.records.keys()].map((id) => this.persist(id)));
  }

  /**
   * 接管会取消当前运行；交还仅释放控制权，不自动恢复模型执行。
   * @param id 当前窗口持有的会话标识。
   * @param resume true 表示交还，false 表示接管。
   * @returns 原生回执确认为 executed 后完成。
   * @throws 会话不存在、原生控制失败或回执未确认执行。
   */
  async browserControl(id: string, resume: boolean): Promise<void> {
    const result = record(JSON.parse(await this.get(id).browserControl(resume)));
    if (result["outcome"] !== "executed")
      throw new Error(
        typeof result["error"] === "string" ? result["error"] : "浏览器控制权未能切换",
      );
  }

  /** 决定只能作用于仍有效的申请。 */
  approve(id: string, approval: string, reply: ApprovalReply): void {
    this.get(id).approve(approval, JSON.stringify(reply));
  }
  /** 读取不消费模型输出的原始日志页。 */
  async terminalRead(id: string, terminal: string, offset: string): Promise<TerminalPage> {
    return parseTerminalPage(await this.get(id).readTerminal(terminal, offset, 8192));
  }
  /** 用户终端输入保留二进制字节，不改写为 shell 命令。 */
  terminalInput(id: string, terminal: string, data: Uint8Array): Promise<void> {
    return this.get(id).sendInput(terminal, Buffer.from(data), false);
  }
  /** 排队停止终端，终态由快照确认。 */
  terminalStop(id: string, terminal: string): void {
    this.get(id).stopTerminal(terminal);
  }
  /** 明确的宿主终端动作仍使用原生参数及权限校验。 */
  terminalAction(id: string, arguments_: unknown): Promise<unknown> {
    return this.serialize(id, async () => {
      const item = this.record(id);
      if (item.archived) throw new Error("请先恢复已归档的对话");
      const session = await this.activate(item);
      const result: unknown = JSON.parse(await session.terminalAction(JSON.stringify(arguments_)));
      await this.saveProgress(id);
      return result;
    });
  }

  /** 渲染器离开时取消等待中的生成和审批，历史和后台终端仍由宿主持有。 */
  detach(): void {
    for (const session of this.sessions.values()) session.cancel();
  }

  /** 关闭窗口等待原生停机和最终历史落盘；存储失败不得静默丢弃。 */
  shutdown(): Promise<void> {
    if (this.stopping !== null) return this.stopping;
    this.stopping = (async () => {
      await this.ready;
      await Promise.all(this.mutations.values());
      await this.settings.flush();
      for (const id of this.timers.keys()) this.clearTimer(id);
      const results = await Promise.allSettled(
        [...this.sessions.keys()].map((id) => this.release(id)),
      );
      const saved = await Promise.allSettled(
        [...this.records.keys()].map((id) => this.persist(id)),
      );
      const errors = [...results, ...saved].flatMap((result) =>
        result.status === "rejected" ? [String(result.reason)] : [],
      );
      if (errors.length > 0) throw new Error(errors.join("；"));
    })();
    return this.stopping;
  }

  private async activate(item: ConversationRecord): Promise<NativeAgentSession> {
    const current = this.sessions.get(item.id);
    if (current) return current;
    const configured = (await this.settings.selected())?.settings;
    if (!configured) throw new Error("请先配置供应商并选择默认模型");
    const session = createNativeSession(
      this.userData,
      this.launcher,
      item.snapshot.workspace,
      configured,
      () => this.nativeChanged(item.id),
    );
    try {
      session.restore(item.checkpoint);
    } catch (error) {
      await session.close();
      throw error;
    }
    this.sessions.set(item.id, session);
    return session;
  }

  private async release(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    await session.close();
    this.capture(id);
    this.sessions.delete(id);
    const item = this.records.get(id);
    if (item) item.snapshot = resumedSnapshot(item.snapshot);
  }

  private project(item: ConversationRecord): AgentConversation {
    const session = this.sessions.get(item.id);
    const snapshot = session ? parseSnapshot(session.snapshot()) : item.snapshot;
    return {
      ...snapshot,
      id: item.id,
      title: item.title,
      model: snapshot.run?.status === "running" ? item.model : (this.defaultModel ?? "未选择模型"),
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      archived: item.archived,
      origin: item.origin,
      article: this.articleLocations.get(item.id) ?? null,
      draft: item.draft,
      storageError: this.storageErrors.get(item.id) ?? null,
    };
  }

  private nativeChanged(id: string): void {
    const item = this.records.get(id);
    // N-API 通知可能晚于 close 到达；已释放资源不再拥有持久化记录的写权限。
    if (!item || !this.sessions.has(id)) return;
    // 活动时间由创建、发送和改名更新；资源退出通知不能把旧对话重新排到最前面。
    this.changed(id);
    if (this.stopping !== null || this.timers.has(id)) return;
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id);
        void this.saveProgress(id);
      }, 200),
    );
  }

  private capture(id: string): void {
    const item = this.records.get(id);
    const session = this.sessions.get(id);
    if (item && session) {
      item.snapshot = { ...parseSnapshot(session.snapshot()), id };
      item.checkpoint = session.checkpoint();
    }
  }

  private async persist(id: string): Promise<void> {
    this.clearTimer(id);
    const item = this.records.get(id);
    if (!item) return;
    try {
      this.capture(id);
      await (await this.recordStore(item)).save(item);
      if (this.storageErrors.delete(id)) this.changed(id);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      this.storageErrors.set(id, `对话尚未保存：${message}`);
      this.changed(id);
      throw cause;
    }
  }

  private async saveProgress(id: string): Promise<void> {
    try {
      await this.persist(id);
    } catch (error) {
      // persist 已把错误放进可见会话状态；运行结果仍以原生回执为准。
      console.error("Agent 对话保存失败", error);
    }
  }

  private clearTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(id);
  }

  private recordStore(item: ConversationRecord): Promise<ConversationStore> {
    return item.article
      ? this.articles.store(item.snapshot.workspace)
      : Promise.resolve(this.store);
  }

  private async refreshArticle(item: ConversationRecord): Promise<void> {
    if (!item.article) return;
    try {
      const location = await this.articles.location(item);
      if (location) this.articleLocations.set(item.id, location);
    } catch (error) {
      this.articleLocations.set(item.id, {
        ...item.article,
        status: "unavailable",
        heading: null,
        line: null,
        paragraph: "",
        error: String(error),
      });
    }
  }

  /** 已提交移动同步文章归属；删除保留原路径和历史，不级联删除对话。 */
  async remapArticles(root: string, changes: { from: string; to: string | null }[]): Promise<void> {
    await this.attachVault(root);
    for (const item of this.records.values()) {
      if (!item.article || item.snapshot.workspace !== root) continue;
      await this.serialize(item.id, async () => {
        for (const change of changes) {
          const binding = item.article;
          if (
            binding &&
            change.to !== null &&
            (binding.path === change.from || binding.path.startsWith(`${change.from}/`))
          ) {
            const path = change.to + binding.path.slice(change.from.length);
            item.article = {
              ...binding,
              path,
              title: path.split("/").at(-1)!.replace(/\.md$/iu, ""),
            };
          }
        }
        await this.refreshArticle(item);
        await this.persist(item.id);
        this.changed(item.id);
      });
    }
  }

  private serialize<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.mutations.get(id) ?? Promise.resolve();
    const result = previous.then(async () => {
      await this.ready;
      this.ensureOpen();
      if (this.loadError) throw this.loadError;
      return action();
    });
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.mutations.set(id, settled);
    void settled.then(() => {
      if (this.mutations.get(id) === settled) this.mutations.delete(id);
    });
    return result;
  }

  private record(id: string): ConversationRecord {
    const item = this.records.get(id);
    if (!item) throw new Error("对话不存在或已删除");
    return item;
  }
  private ensureOpen(): void {
    if (this.stopping !== null) throw new Error("Agent 服务正在关闭");
  }
  private get(id: string): NativeAgentSession {
    this.ensureOpen();
    const session = this.sessions.get(id);
    if (!session) throw new Error("此会话没有正在运行的资源，请先发送消息");
    return session;
  }
}

/** 重启与归档释放只保留阅读和继续对话所需状态，旧审批与进程不可恢复。 */
function resumedSnapshot(snapshot: AgentSnapshot): AgentSnapshot {
  const interrupted = (run: AgentSnapshot["run"]): AgentSnapshot["run"] =>
    run?.status === "running"
      ? { ...run, status: "cancelled", error: "上次运行已中断，可继续任务或发送新消息。" }
      : run;
  return {
    ...snapshot,
    closed: false,
    approvals: [],
    terminals: [],
    browser: { status: "idle", tabs: [], receipts: [], error: null },
    run: interrupted(snapshot.run),
    turns: snapshot.turns.map((turn) => ({ ...turn, run: interrupted(turn.run) ?? turn.run })),
  };
}
