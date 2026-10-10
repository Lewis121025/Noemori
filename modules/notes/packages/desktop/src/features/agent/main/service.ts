import { parseReferences, type AgentReference } from "../shared/references";
import {
  conversationInput,
  readConversationInput,
  matchesConversationDraft,
} from "../shared/input";
import {
  parseAttachmentIds,
  MAX_ATTACHMENTS,
  type AgentAttachment,
  type AttachmentPreview,
  type AttachmentUpload,
} from "../shared/attachments";
import { readConversationContent } from "./content-reader";
import type { ConversationContent } from "../shared/content";
import { AttachmentStore } from "./attachments";
import { rethrowAfterCleanup } from "./cleanup";
import { branchCheckpoint, relocateCheckpoint, type NativeAgentSession } from "@noemori/agent-node";
import { mkdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
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
  UiPreviewTarget,
  UiPreviewFrame,
  UiPermissions,
  BrowserHumanInput,
} from "../shared/api";
import { canResumeRun, isActiveRun } from "../shared/run-actions";
import { newConversationQueue, type ConversationQueue } from "../shared/queue";
import { parseModelSelection } from "../shared/providers";
import type {
  DiscoveredModel,
  ModelSelection,
  ProviderCatalog,
  ProviderConnection,
  ProviderUpdate,
} from "../shared/providers";
import { parseSnapshot, parseTerminalPage, record, text as readText } from "../shared/parse";
import { AgentProviderStore } from "./providers";
import { parsePrivateJson } from "./private-json";
import { ConversationStore, conversationTitle, type ConversationRecord } from "./conversations";
import { createNativeSession } from "./native-session";
import type { BrowserWorkspace } from "./browser-workspace";

/** 服务只持有窗口浏览器的生命周期与显示契约，不接触其 CDP 内部状态。 */
type BrowserResource = Pick<
  BrowserWorkspace,
  "ready" | "close" | "setHuman" | "show" | "hide" | "listDownloads" | "saveDownload"
>;
import type { BrowserNavigation, BrowserViewPlacement, BrowserDownload } from "../shared/browser";
import { installUiRuntime } from "./ui-runtime";
import { emptyUi } from "../shared/ui";
import { parsePreviewFrame } from "../shared/preview";
import { ArticleLibrary } from "./articles";
import { isEntryPath } from "../../reader/shared/file-browser";
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
  private legacyModelSelection: ModelSelection | null = null;
  private readonly store: ConversationStore;
  private readonly attachments: AttachmentStore;
  private readonly articles: ArticleLibrary;
  private readonly articleLocations = new Map<string, ArticleLocation>();
  private readonly loadedVaults = new Set<string>();
  private readonly ready: Promise<void>;
  private issues: string[] = [];
  private loadError: Error | null = null;
  private stopping: Promise<void> | null = null;
  private readonly browsers = new Map<string, BrowserResource>();
  private readonly handoffReturns = new Map<string, { id: string; error: string | null }>();

  /** 绑定窗口服务并读取历史；构造时不启动模型或恢复终端。 */
  constructor(
    private readonly userData: string,
    private readonly launcher: string,
    private readonly changed: (id: string) => void,
    private readonly createBrowser?: (id: string, changed: () => void) => BrowserResource,
  ) {
    this.settings = new AgentProviderStore(userData);
    this.store = new ConversationStore(userData);
    this.attachments = new AttachmentStore(userData);
    this.articles = new ArticleLibrary(userData);
    this.ready = this.load();
  }

  private async load(): Promise<void> {
    try {
      const loaded = await this.store.load();
      this.issues = loaded.issues;
      try {
        this.legacyModelSelection = await this.settings.legacySelection();
      } catch (cause) {
        this.issues.push(`供应商配置读取失败：${String(cause)}`);
      }
      for (const item of loaded.records) {
        if (loaded.legacyIds.includes(item.id)) item.modelSelection = this.legacyModelSelection;
        item.snapshot = resumedSnapshot(item.snapshot);
        item.queue = restoredQueue(item.queue);
        this.records.set(item.id, item);
      }
    } catch (cause) {
      this.loadError = cause instanceof Error ? cause : new Error(String(cause));
      this.issues = [`对话目录读取失败：${this.loadError.message}`];
    }
  }

  /**
   * @param id 持久化会话身份。
   * @returns 下一轮选择的无密钥投影；未选择模型时返回 null。
   * @throws 会话目录不可读、会话不存在、服务关闭或模型配置无效时拒绝。
   */
  async settingsGet(id: string): Promise<PublicModelSettings | null> {
    await this.ready;
    this.ensureOpen();
    return this.settings.public(this.record(id).modelSelection);
  }
  /** 读取全部供应商的公开配置；不解密，也不启动运行。 */
  providersGet(): Promise<ProviderCatalog> {
    return this.settings.catalog();
  }
  /**
   * @param connection 用户填写的连接草稿，不要求模型 ID。
   * @returns 当前接口可用模型；失败原样交付，不修改已保存连接。
   * @throws 服务已关闭、认证或模型接口失败时拒绝。
   */
  providersDiscover(connection: ProviderConnection): Promise<DiscoveredModel[]> {
    this.ensureOpen();
    return this.settings.discover(connection);
  }
  /** 保存连接，所有会话从下一轮读取新配置；保存失败保留上一份配置。 */
  providersSave(settings: ProviderUpdate): Promise<ProviderCatalog> {
    return this.updateProviders(() => this.settings.save(settings));
  }
  /** 删除独立供应商；删除当前选择后暂停新轮启动，已有运行继续完成。 */
  providersRemove(id: string): Promise<ProviderCatalog> {
    return this.updateProviders(() => this.settings.remove(id));
  }
  /** 获取保存连接的模型目录；接口失败不修改连接或对话选择。 */
  providersRefresh(id: string): Promise<ProviderCatalog> {
    return this.updateProviders(() => this.settings.refresh(id));
  }
  /**
   * 保存单条对话下一轮选择；正在运行的原生资源继续使用派发时的配置。
   * @param id 目标对话身份。
   * @param value 供应商、模型与可选推理强度。
   * @returns 已落盘的选择；回执不携带可能过时的消息或草稿。
   * @throws 对话或模型缺失、能力不支持或保存失败时拒绝，保留旧选择。
   */
  modelSelect(id: string, value: ModelSelection): Promise<ModelSelection> {
    const selection = parseModelSelection(value);
    return this.serialize(id, async () => {
      const item = this.record(id);
      await this.settings.public(selection);
      this.capture(id);
      const next = { ...item, modelSelection: selection };
      await (await this.recordStore(item)).save(next);
      item.modelSelection = selection;
      this.changed(id);
      return { ...selection };
    });
  }
  private async updateProviders(
    operation: () => Promise<ProviderCatalog>,
  ): Promise<ProviderCatalog> {
    await this.ready;
    this.ensureOpen();
    const catalog = await operation();
    for (const id of this.records.keys()) this.changed(id);
    return catalog;
  }

  /**
   * 确认工作目录和名称后只创建可保存的对话，原生资源留到首次发送。
   * @param workspace 经 IPC 确认的可选关联目录；null 表示独立对话。
   * @param title 用户输入的会话名称。
   * @returns 具有稳定身份的已保存会话；不发送模型请求。
   * @throws 目录无效或保存失败时拒绝，不发布未保存记录。
   */
  create(workspace: string | null, title: string): Promise<AgentConversation> {
    return this.createRecord(workspace, title, null);
  }

  /**
   * 加载已打开库中的文章历史；同身份的库副本按会话顺序检查归属，不启动模型。
   * @param root 已打开笔记库的规范绝对路径。
   * @returns 库内历史与导入副本接入完成后兑现；单条冲突或恢复错误保留在加载问题中。
   * @throws 服务关闭、目录不规范或库目录读取失败时拒绝。
   */
  attachVault(root: string): Promise<void> {
    return this.serialize(`vault:${root}`, async () => {
      if (this.loadedVaults.has(root)) return;
      const loaded = await (await this.articles.store(root)).load();
      this.issues.push(...loaded.issues.map((issue) => `${root}：${issue}`));
      for (const item of loaded.records) {
        try {
          // 不同库可并发读取，但同身份的归属检查与发布必须保持原子顺序。
          await this.serialize(item.id, async () => {
            if (!item.article) {
              this.issues.push(`${item.title}：库内对话缺少文章归属`);
              return;
            }
            const existing = this.records.get(item.id);
            if (existing && existing.snapshot.workspace !== root) {
              this.issues.push(
                `${item.title}：另一个已打开的库副本含有相同对话，请重启后打开需要的副本`,
              );
              return;
            }
            if (item.snapshot.workspace !== root && item.checkpoint !== null)
              item.checkpoint = await relocateCheckpoint(item.checkpoint, root);
            if (loaded.legacyIds.includes(item.id)) item.modelSelection = this.legacyModelSelection;
            item.snapshot = { ...resumedSnapshot(item.snapshot), workspace: root };
            item.queue = restoredQueue(item.queue);
            item.linkedWorkspace = root;
            this.records.set(item.id, item);
            await this.refreshArticle(item);
          });
        } catch (error) {
          this.issues.push(`${item.title}：文章对话未能恢复，原记录仍保留：${String(error)}`);
        }
      }
      for (const imported of await this.articles.imports(root)) {
        try {
          await this.adoptImportedArticles(imported.source, root, imported.path);
        } catch (error) {
          this.issues.push(`${imported.path}：文章历史未能接入，副本仍保留：${String(error)}`);
        }
      }
      this.loadedVaults.add(root);
    });
  }

  /**
   * 将目录副本的文章历史接到应用仓库，保留对话身份与分支，原历史文件保持原位。
   * @param source 原目录的规范绝对路径。
   * @param root 应用仓库的规范绝对路径。
   * @param prefix 已完成导入的库内目录。
   * @returns 文章历史已持久化到仓库并发布归属后兑现；已接入的相同历史不重复覆盖。
   * @throws 原目录仍有运行资源、无法读取或持久化历史、存在另一份不同归属的相同身份时拒绝，不覆盖已有归属。
   */
  async importArticleLibrary(source: string, root: string, prefix: string): Promise<void> {
    if (!isEntryPath(prefix)) throw new Error("文章历史的导入目录无效");
    await this.attachVault(root);
    await this.serialize(`vault:${root}`, () => this.adoptImportedArticles(source, root, prefix));
  }

  private async adoptImportedArticles(source: string, root: string, prefix: string): Promise<void> {
    const loaded = await (await this.articles.store(join(root, prefix))).load();
    if (loaded.records.length === 0) {
      if (loaded.issues.length) throw new Error(loaded.issues.join("；"));
      return;
    }
    const store = await this.articles.store(root);
    for (const item of loaded.records) {
      // 库级队列只管理批次，记录归属必须与选择和草稿共用会话级写入顺序。
      await this.serialize(item.id, async () => {
        if (!item.article) throw new Error(`${item.title}：文章历史缺少来源`);
        const path = `${prefix}/${item.article.path}`;
        const existing = this.records.get(item.id);
        // 仓库中的记录是最新归属，不能被副本内保留的旧路径、归档或草稿反向覆盖。
        if (existing?.snapshot.workspace === root && existing.article) return;
        if (existing && existing.snapshot.workspace !== source)
          throw new Error(`${item.title}：相同对话已属于另一份资料，保留已有归属`);
        // 原生工作目录在创建资源时冻结，历史接入不能转移仍被现有资源持有的归属。
        if (this.sessions.has(item.id))
          throw new Error(
            `${item.title}：原目录的对话仍占用运行资源，历史未接入；请先归档原对话或重启应用后重试`,
          );
        const previousRoot = item.snapshot.workspace;
        const relocateReferences = (references: AgentReference[]) =>
          references.map((reference) =>
            reference.source &&
            (reference.source.root === previousRoot || reference.source.root === source)
              ? {
                  ...reference,
                  source: { ...reference.source, root, path: `${prefix}/${reference.source.path}` },
                }
              : reference,
          );
        if (item.draftReferences)
          item.draftReferences = parseReferences(relocateReferences(item.draftReferences));
        item.queue = {
          ...item.queue,
          messages: item.queue.messages.map((message) => {
            const input = readConversationInput(message.text);
            return input.references.some(
              (reference) =>
                reference.source?.root === previousRoot || reference.source?.root === source,
            )
              ? {
                  ...message,
                  text: conversationInput(
                    input.text,
                    relocateReferences(input.references),
                    input.attachments,
                    input.directory,
                  ),
                }
              : message;
          }),
        };
        if (item.checkpoint !== null)
          item.checkpoint = await relocateCheckpoint(item.checkpoint, root);
        if (loaded.legacyIds.includes(item.id)) item.modelSelection = this.legacyModelSelection;
        item.snapshot = { ...resumedSnapshot(item.snapshot), workspace: root };
        item.linkedWorkspace = root;
        item.article = { ...item.article, path };
        item.queue = restoredQueue(item.queue);
        await store.save(item);
        this.records.set(item.id, item);
        await this.refreshArticle(item);
        this.changed(item.id);
      });
    }
    if (loaded.issues.length) throw new Error(loaded.issues.join("；"));
  }

  /** 确认名称后创建文章对话；先验证文章已保存，取消创建不会发送模型请求。 */
  async createArticle(request: ArticleConversationRequest): Promise<AgentConversation> {
    await this.attachVault(request.root);
    if ((await this.articles.read(request.root, request.path)) === null)
      throw new Error("请先保存文章，再插入对话");
    return this.createRecord(request.root, request.title, request.path);
  }

  private createRecord(
    workspace: string | null,
    title: string,
    articlePath: string | null,
  ): Promise<AgentConversation> {
    return this.serialize("create", async () => {
      const name = conversationTitle(title);
      const id = randomUUID();
      const root = workspace === null ? this.executionDirectory(id) : await realpath(workspace);
      if (workspace !== null && !(await stat(root)).isDirectory())
        throw new Error("工作目录必须是文件夹");
      const now = Date.now();
      const snapshot: AgentSnapshot = {
        id,
        workspace: root,
        revision: 0,
        closed: false,
        run: null,
        turns: [],
        messages: [],
        terminals: [],
        approvals: [],
        browser: { status: "idle", tabs: [], receipts: [], error: null },
        ui: emptyUi(),
      };
      const item: ConversationRecord = {
        id,
        title: name,
        createdAt: now,
        updatedAt: now,
        archived: false,
        origin: null,
        linkedWorkspace: workspace === null ? null : root,
        article:
          articlePath === null
            ? null
            : {
                path: articlePath,
                title: articlePath.split("/").at(-1)!.replace(/\.md$/iu, ""),
                markerId: id,
              },
        draft: "",
        queue: newConversationQueue(),
        model: null,
        modelSelection: null,
        snapshot,
        checkpoint: null,
      };
      const location = await this.articles.location(item);
      await (await this.recordStore(item)).save(item);
      this.records.set(id, item);
      if (location) this.articleLocations.set(id, location);
      this.changed(id);
      return this.project(item);
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
        if (isActiveRun(turn.run)) throw new Error("此轮尚未结束，请选择较早轮次或分叉当前内容");
      }
      this.capture(id);
      const derived =
        source.checkpoint === null
          ? null
          : record(
              parsePrivateJson(
                await branchCheckpoint(source.checkpoint, request.afterTurnId ?? undefined),
                "对话检查点",
              ),
            );
      const nextId = randomUUID();
      const root =
        source.linkedWorkspace ??
        (derived === null ? this.executionDirectory(nextId) : await this.managedWorkspace(nextId));
      const checkpoint = derived === null ? null : readText(derived, "checkpoint");
      const snapshot =
        derived === null ? source.snapshot : parseSnapshot(JSON.stringify(derived["snapshot"]));
      const referenced = historyAttachmentIds(snapshot);
      const attachments = (source.attachments ?? []).filter((file) => referenced.has(file.id));
      const now = Date.now();
      const item: ConversationRecord = {
        id: nextId,
        title,
        createdAt: now,
        updatedAt: now,
        archived: false,
        draft: "",
        queue: newConversationQueue(),
        origin: { conversationId: source.id, title: source.title, turnId: request.afterTurnId },
        ...(attachments.length ? { attachments: structuredClone(attachments) } : {}),
        article: source.article ? { ...source.article } : null,
        linkedWorkspace: source.linkedWorkspace,
        model: source.model,
        modelSelection: source.modelSelection === null ? null : { ...source.modelSelection },
        checkpoint:
          checkpoint !== null && source.linkedWorkspace === null
            ? await relocateCheckpoint(checkpoint, root)
            : checkpoint,
        snapshot: {
          ...snapshot,
          id: nextId,
          workspace: root,
        },
      };
      await this.attachments.copy(source.id, nextId, attachments);
      let location: ArticleLocation | null;
      try {
        this.ensureOpen();
        location = await this.articles.location(item);
        await (await this.recordStore(item)).save(item);
      } catch (cause) {
        return rethrowAfterCleanup(
          cause,
          () => this.attachments.remove(nextId),
          "对话分叉失败且附件副本未能完整回滚",
        );
      }
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
            workspace: item.linkedWorkspace,
            model:
              (status === "running" || status === "paused"
                ? item.model
                : item.modelSelection?.modelId) ?? "未选择模型",
            modelSelection: item.modelSelection,
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
   * @throws 会话目录不可读、会话不存在或服务正在关闭时拒绝。
   */
  async snapshot(id: string): Promise<AgentConversation> {
    await this.ready;
    this.ensureOpen();
    const item = this.record(id);
    await this.refreshArticle(item);
    return this.project(item);
  }

  /**
   * 系统选择器确认的文件先冻结，再与当前草稿一起原子发布。
   * @param id 选择时捕获的会话；迟到结果不会写入另一条对话。
   * @param paths 主进程持有的文件选择结果。
   * @returns 本批新增的附件描述，取消选择时为空。
   * @throws 归档、超限、关闭、文件读取或落盘失败时拒绝并回滚本批副本。
   */
  addAttachments(id: string, paths: (string | AttachmentUpload)[]): Promise<AgentAttachment[]> {
    return this.serialize(id, async () => {
      const item = this.record(id);
      if (item.archived) throw new Error("请先恢复已归档的对话");
      if ((item.draftAttachmentIds?.length ?? 0) + paths.length > MAX_ATTACHMENTS)
        throw new Error("每条消息最多添加八个附件");
      if (!paths.length) return [];
      const files = await this.attachments.import(id, paths);
      try {
        this.ensureOpen();
        this.capture(id);
        const attachments = [...(item.attachments ?? []), ...files];
        const draftAttachmentIds = [
          ...(item.draftAttachmentIds ?? []),
          ...files.map((file) => file.id),
        ];
        await this.writeRecord({ ...item, attachments, draftAttachmentIds });
        item.attachments = attachments;
        item.draftAttachmentIds = draftAttachmentIds;
        this.changed(id);
        return structuredClone(files);
      } catch (cause) {
        return rethrowAfterCleanup(
          cause,
          () => this.attachments.discard(id, files),
          "附件记录未保存且副本未能完整回滚",
        );
      }
    });
  }

  /** @param id 所属对话；@param fileId 附件身份；@returns 有界预览；@throws 归属、读取或关闭失败时拒绝。 */
  async attachmentPreview(id: string, fileId: string): Promise<AttachmentPreview> {
    await this.ready;
    this.ensureOpen();
    const [file] = this.ownedAttachments(this.record(id), [fileId]);
    if (!file) throw new Error("附件不存在");
    return this.attachments.preview(id, file);
  }

  /** @param id 所属会话；@param fileId 附件身份；@returns 同一私有副本的原始快照；@throws 归属、完整性或关闭失败时拒绝。 */
  async attachmentContent(id: string, fileId: string): Promise<AttachmentUpload> {
    await this.ready;
    this.ensureOpen();
    const [file] = this.ownedAttachments(this.record(id), [fileId]);
    if (!file) throw new Error("附件不存在");
    const bytes = await this.attachments.bytes(id, file);
    this.ensureOpen();
    return { name: file.name, bytes };
  }

  /** @param id 所属会话；@param reference 用户查看的文件引用；@returns 目录边界内的快照或明确请求的外部内容；@throws 会话、地址、读取或关闭失败时拒绝。 */
  async contentPreview(id: string, reference: string): Promise<ConversationContent> {
    await this.ready;
    this.ensureOpen();
    const item = this.record(id),
      workspace = item.snapshot.workspace;
    const content = await readConversationContent(workspace, reference);
    this.ensureOpen();
    if (this.record(id) !== item || item.snapshot.workspace !== workspace)
      throw new Error("对话工作区已改变，请重新预览");
    return content;
  }

  /** @param id 所属对话；@param fileId 已拥有的附件；@returns 已验证内容的私有路径；@throws 会话读取、归属或完整性错误时拒绝。 */
  async attachmentPath(id: string, fileId: string): Promise<string> {
    await this.ready;
    this.ensureOpen();
    const [file] = this.ownedAttachments(this.record(id), [fileId]);
    if (!file) throw new Error("附件不存在");
    await this.attachments.images(id, [file]);
    this.ensureOpen();
    return this.attachments.path(id, file);
  }

  private ownedAttachments(item: ConversationRecord, ids: string[]): AgentAttachment[] {
    return parseAttachmentIds(ids).map((id) => {
      const file = item.attachments?.find((file) => file.id === id);
      if (!file) throw new Error("附件不存在或不属于此对话");
      return file;
    });
  }

  private messageInput(
    item: ConversationRecord,
    text: string,
    references: AgentReference[],
    ids: string[],
  ): string {
    const files = this.ownedAttachments(item, ids);
    return conversationInput(
      text,
      references,
      files,
      item.attachments?.length ? this.attachments.directory(item.id) : null,
    );
  }

  private async publishInput<T>(id: string, files: AgentAttachment[], accept: () => T): Promise<T> {
    const published = await this.attachments.publish(id, files);
    try {
      this.ensureOpen();
      return accept();
    } catch (cause) {
      return rethrowAfterCleanup(
        cause,
        () => this.attachments.unpublish(id, published),
        "输入未接受且附件发布未能完整撤销",
      );
    }
  }

  /**
   * 显式发送才恢复运行资源；归档对话必须先恢复，历史工具不自动重放。
   * @param id 目标会话。
   * @param text 本轮用户输入。
   * @returns 原生任务标识；运行开始后的保存错误通过 storageError 呈现。
   * @throws 已归档、输入无效、恢复失败或发送前无法保存时拒绝。
   */
  start(
    id: string,
    text: string,
    references: AgentReference[] = [],
    attachments: string[] = [],
  ): Promise<string> {
    return this.serialize(id, async () => {
      const input = this.messageInput(this.record(id), text, references, attachments);
      const run = await this.beginRun(this.record(id), input, true);
      await this.dispatchQueued(id);
      return run;
    });
  }

  /**
   * 向指定活动轮次补充指令，原生接受后才消费同文草稿。
   * @param id 目标对话。
   * @param runId 当前运行身份，不能用会话身份代替。
   * @param text 下一次模型请求使用的原始文字。
   * @returns 接受指令的原运行编号，不创建新轮。
   * @throws 运行已变化、输入无效或接受前无法保存时拒绝，接受后的存储错误通过快照呈现。
   */
  steer(
    id: string,
    runId: string,
    text: string,
    references: AgentReference[] = [],
    attachments: string[] = [],
  ): Promise<string> {
    return this.serialize(id, async () => {
      const item = this.record(id);
      const input = this.messageInput(item, text, references, attachments);
      const run = this.project(item).run;
      if (run?.id !== runId || !isActiveRun(run)) throw new Error("运行已变化，补充指令未接收");
      await this.persist(id);
      const files = this.ownedAttachments(item, attachments);
      const images = await this.attachments.images(id, files);
      this.ensureOpen();
      if (files.length && typeof this.get(id).steerWithAttachments !== "function")
        throw new Error("原生附件模块尚未更新，请重新构建并重启应用");
      const accepted = await this.publishInput(id, files, () =>
        files.length
          ? this.get(id).steerWithAttachments(
              runId,
              input,
              images.length ? JSON.stringify(images) : undefined,
              files.some((file) => !file.image),
            )
          : this.get(id).steer(runId, input),
      );
      if (
        matchesConversationDraft(input, item.draft, item.draftReferences, item.draftAttachmentIds)
      ) {
        item.draft = "";
        delete item.draftReferences;
        delete item.draftAttachmentIds;
      }
      await this.saveProgress(id);
      this.changed(id);
      return accepted;
    });
  }

  /**
   * @param id 目标对话。
   * @returns 独立队列副本，不激活模型或终端。
   * @throws 会话目录不可读、会话不存在或服务已关闭时拒绝。
   */
  async queueGet(id: string): Promise<ConversationQueue> {
    await this.ready;
    this.ensureOpen();
    return structuredClone(this.record(id).queue);
  }

  /**
   * 追问先落盘再发布，当前任务成功结束后按顺序派发。
   * @param id 目标对话。
   * @param runId 界面捕获的运行身份，允许同一轮刚完成的回执竞态。
   * @param text 下一轮原始文字，匹配当前草稿时才消费草稿。
   * @returns 保存后的队列副本；派发失败会暂停队列并保留内容。
   * @throws 会话归档、运行已变化、输入或队列超限、加入前写盘失败时拒绝。
   */
  queueAdd(
    id: string,
    runId: string,
    text: string,
    references: AgentReference[] = [],
    attachments: string[] = [],
  ): Promise<ConversationQueue> {
    return this.serialize(id, async () => {
      const item = this.record(id);
      const input = this.messageInput(item, text, references, attachments);
      const run = this.project(item).run;
      if (item.archived) throw new Error("请先恢复已归档的对话");
      if (run?.id !== runId || !["running", "completed"].includes(run.status))
        throw new Error("运行已变化，追问未加入队列");
      if (item.queue.messages.length >= 16) throw new Error("最多排队 16 条追问");
      const consumeDraft = matchesConversationDraft(
        input,
        item.draft,
        item.draftReferences,
        item.draftAttachmentIds,
      );
      await this.commitQueue(
        item,
        {
          ...item.queue,
          messages: [...item.queue.messages, { id: randomUUID(), text: input, state: "queued" }],
        },
        consumeDraft ? "" : item.draft,
        consumeDraft,
      );
      await this.dispatchQueued(id);
      return structuredClone(item.queue);
    });
  }

  /**
   * @param id 目标对话。
   * @param messageId 待发送或恢复后未确认项的稳定身份。
   * @returns 移除后的队列副本，不取消已经开始的任务。
   * @throws 记录已变化或保存失败时拒绝，保留原队列。
   */
  queueRemove(id: string, messageId: string): Promise<ConversationQueue> {
    return this.serialize(id, async () => {
      const item = this.record(id);
      const removed = item.queue.messages.find((message) => message.id === messageId);
      if (!removed) throw new Error("追问已变化");
      const messages = item.queue.messages.filter((message) => message.id !== messageId);
      // 未确认提示属于发送中的条目；用户核对并移除全部此类条目后，不能继续误报。
      const error =
        removed.state === "sending" && !messages.some((message) => message.state === "sending")
          ? null
          : item.queue.error;
      await this.commitQueue(
        item,
        messages.length ? { ...item.queue, messages, error } : newConversationQueue(),
      );
      await this.dispatchQueued(id);
      return structuredClone(item.queue);
    });
  }

  /**
   * @param id 目标对话。
   * @param paused 是否暂停后续追问，不中断当前任务。
   * @returns 保存后的队列副本，显式继续可从中断状态派发新轮。
   * @throws 写盘失败或恢复后的发送状态未确认时拒绝；后者必须先核对历史并移除该项。
   */
  queuePause(id: string, paused: boolean): Promise<ConversationQueue> {
    return this.serialize(id, async () => {
      const item = this.record(id);
      if (!paused && item.queue.messages.some((message) => message.state === "sending"))
        throw new Error("上次追问发送状态未确认，请先查看对话记录并移除该项");
      await this.commitQueue(item, { ...item.queue, paused, error: null });
      if (!paused) await this.dispatchQueued(id, true);
      return structuredClone(item.queue);
    });
  }

  private async commitQueue(
    item: ConversationRecord,
    queue: ConversationQueue,
    draft = item.draft,
    clearReferences = false,
  ): Promise<void> {
    this.capture(item.id);
    const next = { ...item, queue, draft };
    if (clearReferences) {
      delete next.draftReferences;
      delete next.draftAttachmentIds;
    }
    await this.writeRecord(next);
    item.queue = queue;
    item.draft = draft;
    if (clearReferences) {
      delete item.draftReferences;
      delete item.draftAttachmentIds;
    }
    await this.cleanupAttachments(item);
    this.changed(item.id);
  }

  private async pauseQueue(item: ConversationRecord, error: string | null): Promise<void> {
    if (!item.queue.messages.length) return;
    // 停止派发必须立即生效；落盘失败由 storageError 提示，不能继续执行后续任务。
    item.queue = { ...item.queue, paused: true, error };
    await this.saveProgress(item.id);
    this.changed(item.id);
  }

  private async dispatchQueued(id: string, explicit = false): Promise<void> {
    const item = this.record(id);
    while (!this.stopping && !item.archived && !item.queue.paused && item.queue.messages.length) {
      const run = this.project(item).run;
      if (isActiveRun(run)) return;
      if (!explicit && run?.status !== "completed") {
        await this.pauseQueue(item, null);
        return;
      }
      const first = item.queue.messages[0]!;
      if (first.state === "sending") {
        await this.pauseQueue(item, "上次追问发送状态未确认，请先查看对话记录；此条不会自动重发");
        return;
      }
      try {
        // 崩溃后无法区分派发前后，持久化发送意图，让恢复时明确停下而非重复执行。
        await this.commitQueue(item, {
          ...item.queue,
          messages: [{ ...first, state: "sending" }, ...item.queue.messages.slice(1)],
        });
        await this.beginRun(item, first.text, false);
      } catch (cause) {
        item.queue = {
          ...item.queue,
          messages: [{ ...first, state: "queued" }, ...item.queue.messages.slice(1)],
        };
        await this.pauseQueue(item, cause instanceof Error ? cause.message : String(cause));
        return;
      }
      item.queue = { ...item.queue, messages: item.queue.messages.slice(1), error: null };
      await this.saveProgress(id);
      this.changed(id);
      explicit = false;
    }
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
      await this.pauseQueue(item, null);
      await this.saveProgress(id);
      this.changed(id);
    });
  }

  /**
   * 恢复用户指定的中断节点，不追加用户消息或重新读取文章上下文，不消费未发送草稿。
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
      if (item.archived) throw new Error("请先恢复已归档的对话");
      const session = await this.activate(item);
      await this.persist(item.id);
      const selected = await this.settings.selected(item.modelSelection);
      if (!selected) throw new Error("请为此对话选择模型");
      this.ensureOpen();
      if (typeof session.resumeConfigured !== "function")
        throw new Error("原生恢复模块尚未更新，请重新构建并重启应用");
      await this.claimResources(item.id, session);
      const started = session.resumeConfigured(
        runId,
        JSON.stringify(selected.settings),
        selected.binding,
      );
      item.model = selected.settings.model;
      item.updatedAt = Date.now();
      await this.saveProgress(item.id);
      this.changed(item.id);
      await this.dispatchQueued(id);
      return started;
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
    const selected = await this.settings.selected(item.modelSelection);
    if (!selected) throw new Error("请为此对话选择模型");
    const submitted = readConversationInput(text);
    const files = this.ownedAttachments(
      item,
      submitted.attachments.map((file) => file.id),
    );
    if (files.some((file) => file.image) && !selected.settings.vision)
      throw new Error("当前模型不支持图片，请选择支持视觉的模型或移除图片附件");
    if (files.some((file) => !file.image) && !selected.settings.tools)
      throw new Error("当前模型没有工具读取能力，请更换模型或移除文件附件");
    const images = await this.attachments.images(item.id, files);
    const input = this.messageInput(
      item,
      submitted.text,
      submitted.references,
      files.map((file) => file.id),
    );
    // 关闭可能发生在保存、上下文读取或认证读取期间；派发前必须重新核对生命周期。
    this.ensureOpen();
    if (files.length && typeof session.startConfiguredWithAttachments !== "function")
      throw new Error("原生附件模块尚未更新，请重新构建并重启应用");
    if (isActiveRun(this.project(item).run))
      throw new Error("当前对话已有运行，请排队或补充当前任务");
    await this.claimResources(item.id, session);
    const parameters = [
      JSON.stringify(selected.settings),
      selected.binding,
      input,
      article ? articlePrompt(item.snapshot.workspace, article) : undefined,
    ] as const;
    const run = await this.publishInput(item.id, files, () =>
      images.length
        ? session.startConfiguredWithAttachments(...parameters, JSON.stringify(images))
        : session.startConfigured(...parameters),
    );
    item.model = selected.settings.model;
    if (
      consumeDraft &&
      matchesConversationDraft(input, item.draft, item.draftReferences, item.draftAttachmentIds)
    ) {
      item.draft = "";
      delete item.draftReferences;
      delete item.draftAttachmentIds;
    }
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
      await this.attachments.remove(id);
    });
  }

  /**
   * 草稿按对话独立持久化；切换会话不把未发送文本带给另一个工作目录。
   * @param id 所属会话。
   * @param draft 未发送文本，空字符串表示清空。
   * @param references 最新引用列表；缺省表示无引用。
   * @param attachments 缺省保留异步导入结果，显式列表替换附件选择，空列表明确移除。
   * @returns 草稿保存后兑现。
   * @throws 会话不存在、草稿超过限制或保存失败时拒绝。
   */
  saveDraft(
    id: string,
    draft: string,
    references: AgentReference[] = [],
    attachments?: string[],
  ): Promise<void> {
    const checked = parseReferences(references);
    return this.serialize(id, async () => {
      if (draft.length > 128 * 1024) throw new Error("消息超过 128 KiB");
      const item = this.record(id);
      const files = this.ownedAttachments(item, attachments ?? item.draftAttachmentIds ?? []);
      item.draft = draft;
      if (checked.length) item.draftReferences = checked;
      else delete item.draftReferences;
      if (files.length) item.draftAttachmentIds = files.map((file) => file.id);
      else delete item.draftAttachmentIds;
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
    await Promise.all(
      [...this.records.keys()].map((id) => this.serialize(id, () => this.persist(id))),
    );
  }

  /**
   * 接管暂停当前运行；交还确认后继续同一运行，不增加用户消息。
   * @param id 当前窗口持有的会话标识。
   * @param resume true 表示交还，false 表示接管。
   * @returns 原生回执确认为 executed 后完成。
   * @throws 会话不存在、原生控制失败或回执未确认执行。
   */
  browserControl(id: string, resume: boolean): Promise<void> {
    return this.serialize(id, () => this.changeBrowserControl(id, resume));
  }

  private async changeBrowserControl(id: string, resume: boolean): Promise<void> {
    const result = record(JSON.parse(await this.get(id).browserControl(resume)));
    if (result["outcome"] !== "executed")
      throw new Error(typeof result["error"] === "string" ? result["error"] : "浏览器控制权未能切换");
    this.browsers.get(id)?.setHuman(!resume);
  }

  /** 后台结算不依赖面板挂载；等待运行真正暂停后交还，每个协助身份只尝试一次。 */
  private async settleBrowserHandoff(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session || this.stopping !== null) return;
    const snapshot = parseSnapshot(session.snapshot());
    const handoff = snapshot.browser.handoff;
    if (snapshot.browser.status !== "human" || !handoff || snapshot.run?.status === "running") return;
    if (handoff.status === "waiting" && snapshot.run?.status === "paused") return;
    if (this.handoffReturns.get(id)?.id === handoff.id) return;
    const result: { id: string; error: string | null } = { id: handoff.id, error: null };
    this.handoffReturns.set(id, result);
    try {
      await this.changeBrowserControl(id, true);
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
      this.changed(id);
    }
  }

  /** 用户导航与资源激活共享会话顺序，不依赖模型生成或网页截图。 */
  browserNavigate(id: string, command: BrowserNavigation): Promise<void> {
    return this.serialize(id, async () => {
      const native = await this.activate(this.record(id));
      await native.browserNavigate(JSON.stringify(command));
      this.browsers.get(id)?.setHuman(true);
      this.changed(id);
    });
  }

  /** 只显示当前会话快照登记的真实网页，不接受调试地址或其他窗口身份。 */
  browserView(id: string, placement: BrowserViewPlacement | null): void {
    const browser = this.browsers.get(id);
    if (placement === null) {
      browser?.hide();
      return;
    }
    if (!browser) throw new Error("浏览器尚未启动");
    const snapshot = this.project(this.record(id));
    if (snapshot.browser.status !== "human") {
      browser.hide();
      return;
    }
    const page = snapshot.browser.tabs.find((page) => page.id === placement.page);
    if (!page?.native_target) throw new Error("真实网页视图尚未连接");
    browser.show(page.native_target, { ...placement, human: snapshot.browser.status === "human" });
  }

  /** 返回本对话已登记下载的公开状态。 */
  browserDownloads(id: string): BrowserDownload[] {
    this.record(id);
    return this.browsers.get(id)?.listDownloads() ?? [];
  }

  /** 在应用窗口中保存已有下载，未知身份与写入失败原样返回。 */
  async browserSaveDownload(id: string, download: string): Promise<void> {
    const browser = this.browsers.get(id);
    if (!browser) throw new Error("浏览器尚未启动");
    await browser.saveDownload(download);
  }
  /** 只读取已启动会话的独立画面；不持久化图片，原生失败原样传播。 */
  async uiPreview(id: string, target: UiPreviewTarget): Promise<UiPreviewFrame> {
    return parsePreviewFrame(JSON.parse(await this.get(id).uiPreview(JSON.stringify(target))));
  }
  /** 输入仅交给已接管的专用浏览器；页面和控制权由资源所有者再次核验。 */
  browserInput(id: string, page: string, token: string, input: BrowserHumanInput): Promise<void> {
    return this.get(id).browserInput(page, token, JSON.stringify(input));
  }

  /** 人工画面入口只转发到原生校验过的窗口，损坏回执和后端错误原样交付。 */
  uiInput(
    id: string,
    target: UiPreviewTarget,
    token: string,
    input: BrowserHumanInput,
  ): Promise<void> {
    return this.get(id).uiInput(JSON.stringify(target), token, JSON.stringify(input));
  }
  /** 用户切换真实连接控制权；只有后端确认执行才完成。 */
  async uiControl(id: string, backend: string, resume: boolean): Promise<void> {
    return this.serialize(id, async () => {
      const result = record(JSON.parse(await this.get(id).uiControl(backend, resume)));
      if (result["outcome"] !== "executed")
        throw new Error(
          typeof result["error"] === "string" ? result["error"] : "界面控制权未能切换",
        );
    });
  }

  /** 明确发送任务时交给助手当前页面；交还失败拒绝启动，不能先让模型撞上人工控制状态。 */
  private async claimResources(id: string, session: NativeAgentSession): Promise<void> {
    const snapshot = parseSnapshot(session.snapshot());
    if (snapshot.browser.status === "human") {
      const result = record(JSON.parse(await session.browserControl(true)));
      if (result["outcome"] !== "executed")
        throw new Error(
          typeof result["error"] === "string" ? result["error"] : "当前浏览器未能交给助手",
        );
      this.browsers.get(id)?.setHuman(false);
    }
    for (const connection of snapshot.ui.connections) {
      if (!connection.connected || !connection.human) continue;
      const result = record(JSON.parse(await session.uiControl(connection.backend, true)));
      if (result["outcome"] !== "executed")
        throw new Error(
          typeof result["error"] === "string" ? result["error"] : "当前窗口未能交给助手",
        );
    }
    this.ensureOpen();
  }
  /** 用户明确启用浏览器连接时安装本人 Native Messaging 清单，不修改系统权限。 */
  async uiSetup() {
    this.ensureOpen();
    return installUiRuntime(this.userData, this.launcher);
  }
  /**
   * 权限检查会创建资源，必须与发送、删除及停机共享会话的串行顺序。
   * @param id 需要检查原生权限的会话身份。
   * @returns 后端确认观察到的权限状态；不自动授权。
   * @throws 会话不存在、服务关闭、资源激活或原生权限读取失败时拒绝。
   */
  uiPermissions(id: string): Promise<UiPermissions> {
    return this.serialize(id, async () => {
      const session = await this.activate(this.record(id));
      const result = record(JSON.parse(await session.uiPermissions()));
      if (result["outcome"] !== "observed")
        throw new Error(
          typeof result["error"] === "string" ? result["error"] : "原生权限状态未能读取",
        );
      return {
        accessibility: result["accessibility"] === true,
        screen_recording: result["screen_recording"] === true,
        input_monitoring: result["input_monitoring"] === true,
      };
    });
  }

  /** 决定只能作用于仍有效的申请。 */
  approve(id: string, approval: string, reply: ApprovalReply): void {
    this.get(id).approve(approval, JSON.stringify(reply));
  }
  /**
   * 按原始字节游标读取日志，回复必须属于本次请求且能供窗口安全续读。
   * @param id 已启动资源所属的会话。
   * @param terminal 本次读取的原生终端身份。
   * @param offset 独立原始字节游标的十进制文本。
   * @returns 一页最多 8192 字节的原始日志，不消费模型的增量输出。
   * @throws 资源或读取失败、回复归属不符、字节预算超限或分页没有进展时拒绝。
   */
  async terminalRead(id: string, terminal: string, offset: string): Promise<TerminalPage> {
    const limit = 8192;
    const page = parseTerminalPage(await this.get(id).readTerminal(terminal, offset, limit));
    if (page.process.session_id !== terminal || page.offset !== Number(offset))
      throw new Error("终端日志归属或起点与请求不一致");
    const pageBytes = page.next_offset - page.offset;
    if (pageBytes > limit || (page.has_more && pageBytes === 0))
      throw new Error("终端日志回复超出读取预算或分页游标未推进");
    return page;
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
      this.ensureOpen();
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
        [...new Set([...this.sessions.keys(), ...this.browsers.keys()])].map((id) =>
          this.release(id),
        ),
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
    const configured = (await this.settings.selected(item.modelSelection))?.settings;
    if (!configured) throw new Error("请为此对话选择模型");
    // 无目录关联时只授权该对话的私有运行目录；重启或分叉不借用其他对话目录。
    const workspace = item.linkedWorkspace ?? (await this.managedWorkspace(item.id));
    if (item.snapshot.workspace !== workspace) {
      if (item.checkpoint !== null)
        item.checkpoint = await relocateCheckpoint(item.checkpoint, workspace);
      item.snapshot = { ...item.snapshot, workspace };
    }
    // 激活依赖异步配置和目录读取；关闭开始后不得再创建新的资源所有者。
    const attachmentDirectory = await this.attachments.prepare(item.id);
    this.ensureOpen();
    const embedded = this.createBrowser?.(item.id, () => this.changed(item.id));
    let session: NativeAgentSession | undefined;
    try {
      const embeddedHost = embedded ? await embedded.ready : undefined;
      this.ensureOpen();
      session = createNativeSession(
        this.userData,
        this.launcher,
        workspace,
        configured,
        () => this.nativeChanged(item.id),
        item.title,
        attachmentDirectory,
        embeddedHost,
      );
      if (item.checkpoint !== null) session.restore(item.checkpoint);
    } catch (error) {
      return rethrowAfterCleanup(
        error,
        async () => {
          const failures: unknown[] = [];
          try {
            await session?.close();
          } catch (reason) {
            failures.push(reason);
          }
          try {
            await embedded?.close();
          } catch (reason) {
            failures.push(reason);
          }
          if (failures.length === 1) throw failures[0];
          if (failures.length > 1) throw new AggregateError(failures, "会话资源未能完整关闭");
        },
        "会话激活失败且资源未能完整关闭",
      );
    }
    // 只有租约、原生构造与历史恢复全部成功后，资源才归入可见会话。
    if (embedded) this.browsers.set(item.id, embedded);
    this.sessions.set(item.id, session);
    return session;
  }

  private async release(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (session) {
      await session.close();
      this.capture(id);
      this.sessions.delete(id);
      const item = this.records.get(id);
      if (item) item.snapshot = resumedSnapshot(item.snapshot);
    }
    const browser = this.browsers.get(id);
    if (browser) {
      await browser.close();
      this.browsers.delete(id);
    }
    this.handoffReturns.delete(id);
  }

  private project(item: ConversationRecord): AgentConversation {
    const session = this.sessions.get(item.id);
    const snapshot = session ? parseSnapshot(session.snapshot()) : item.snapshot;
    const handoff = this.handoffReturns.get(item.id);
    const handoffError = handoff?.id === snapshot.browser.handoff?.id ? handoff?.error : null;
    return {
      ...snapshot,
      browser: { ...snapshot.browser, error: handoffError ?? snapshot.browser.error },
      id: item.id,
      workspace: item.linkedWorkspace,
      title: item.title,
      model:
        (isActiveRun(snapshot.run) ? item.model : item.modelSelection?.modelId) ?? "未选择模型",
      modelSelection: item.modelSelection,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      archived: item.archived,
      origin: item.origin,
      article: this.articleLocations.get(item.id) ?? null,
      draft: item.draft,
      ...(item.draftReferences ? { draftReferences: structuredClone(item.draftReferences) } : {}),
      ...(item.draftAttachmentIds?.length
        ? {
            draftAttachments: structuredClone(this.ownedAttachments(item, item.draftAttachmentIds)),
          }
        : {}),
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
        void this.serialize(id, async () => {
          await this.settleBrowserHandoff(id);
          await this.saveProgress(id);
          await this.dispatchQueued(id);
        }).catch((error: unknown) => {
          console.error("Agent 对话进度保存失败", error);
        });
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
    const item = this.records.get(id);
    if (!item) return;
    await this.writeRecord(item, true);
    await this.cleanupAttachments(item);
  }

  private async cleanupAttachments(item: ConversationRecord): Promise<void> {
    const referenced = historyAttachmentIds(item.snapshot);
    for (const id of item.draftAttachmentIds ?? []) referenced.add(id);
    for (const message of item.queue.messages)
      for (const file of readConversationInput(message.text).attachments) referenced.add(file.id);
    const unused = (item.attachments ?? []).filter((file) => !referenced.has(file.id));
    if (!unused.length) return;
    try {
      // 引用已落盘后才回收；目录仍保留待清理描述，崩溃或删除失败可在下次保存重试。
      await this.attachments.discard(item.id, unused);
      const attachments = (item.attachments ?? []).filter((file) => referenced.has(file.id));
      await this.writeRecord({ ...item, attachments });
      item.attachments = attachments;
    } catch (cause) {
      // 输入已提交，清理失败不能伪报发送失败；保留目录并交付可见的存储故障。
      this.storageErrors.set(item.id, `附件副本尚未清理：${String(cause)}`);
      this.changed(item.id);
      console.error("Agent 附件清理失败", cause);
    }
  }

  private async writeRecord(item: ConversationRecord, capture = false): Promise<void> {
    const id = item.id;
    try {
      if (capture) this.capture(id);
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

  private executionDirectory(id: string): string {
    return join(this.userData, "agent-workspaces", id);
  }

  private async managedWorkspace(id: string): Promise<string> {
    const directory = this.executionDirectory(id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return realpath(directory);
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

  /**
   * 已提交移动同步文章归属；删除文章保留原路径和历史，不级联删除对话。
   * @param root 已完成文件操作的笔记库规范绝对路径。
   * @param changes 库内旧路径与新路径的映射；null 表示文章已删除。
   * @returns 当前仍归属该库的会话更新并保存后兑现；排队期间已删除或迁出的会话跳过。
   * @throws 库加载、服务关闭或归属保存失败时拒绝。
   */
  async remapArticles(root: string, changes: { from: string; to: string | null }[]): Promise<void> {
    await this.attachVault(root);
    for (const id of [...this.records.keys()]) {
      await this.serialize(id, async () => {
        // 排队期间会话可能已删除或迁入其他库，执行时重新确认当前归属。
        const item = this.records.get(id);
        if (!item?.article || item.snapshot.workspace !== root) return;
        for (const change of changes) {
          const binding: ConversationRecord["article"] = item.article;
          if (
            binding &&
            !binding.removed &&
            (binding.path === change.from || binding.path.startsWith(`${change.from}/`))
          ) {
            if (change.to === null) {
              item.article = { ...binding, removed: true };
              continue;
            }
            const path: string = change.to + binding.path.slice(change.from.length);
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
    // 读取失败时历史归属尚未确定，不能把未加载的记录解释为已经删除。
    if (this.loadError) throw this.loadError;
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

/** 只扫描用户的输入信封，模型回复不能伪造文件所有权或延长副本生命周期。 */
function historyAttachmentIds(snapshot: AgentSnapshot): Set<string> {
  return new Set(
    snapshot.messages.flatMap((message) =>
      message.role !== "user"
        ? []
        : message.content.flatMap((part) =>
            part.type !== "text"
              ? []
              : readConversationInput(part.value).attachments.map((file) => file.id),
          ),
    ),
  );
}

/** 重启只恢复待办内容；派发意图不能证明执行结果，必须交由用户核对。 */
function restoredQueue(queue: ConversationQueue): ConversationQueue {
  return queue.messages.length
    ? {
        ...queue,
        paused: true,
        error: queue.messages.some((message) => message.state === "sending")
          ? "上次追问发送状态未确认，请先查看对话记录；此条不会自动重发"
          : queue.error,
      }
    : newConversationQueue();
}

/** 重启与归档释放只保留阅读和继续对话所需状态，旧审批与进程不可恢复。 */
function resumedSnapshot(snapshot: AgentSnapshot): AgentSnapshot {
  const interrupted = (run: AgentSnapshot["run"]): AgentSnapshot["run"] =>
    isActiveRun(run)
      ? { ...run, status: "cancelled", error: "上次运行已中断，可继续任务或发送新消息。" }
      : run;
  return {
    ...snapshot,
    closed: false,
    approvals: [],
    terminals: [],
    browser: { status: "idle", tabs: [], receipts: [], error: null },
    ui: emptyUi(),
    run: interrupted(snapshot.run),
    turns: snapshot.turns.map((turn) => ({ ...turn, run: interrupted(turn.run) ?? turn.run })),
  };
}
