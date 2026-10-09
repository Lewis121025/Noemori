import { mkdir, readdir, readFile, rename, rm, writeFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentSnapshot, ConversationOrigin } from "../shared/api";
import { boolean, integer, parseSnapshot, record, text } from "../shared/parse";
import { parsePrivateJson } from "./private-json";
import type { ArticleBinding } from "../shared/article";
import { articleConversationHref } from "../shared/article";
import { parseModelSelection, type ModelSelection } from "../shared/providers";
import { isEntryPath } from "../../reader/shared/file-browser";
const conversationId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** 对话独立持有下一轮选择与最后使用的模型；首次运行前没有原生检查点，不保存认证。 */
export type ConversationRecord = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  origin: ConversationOrigin | null;
  article: ArticleBinding | null;
  /** 用户确认的目录关联，与原生快照里的运行目录独立。 */
  linkedWorkspace: string | null;
  draft: string;
  model: string | null;
  modelSelection: ModelSelection | null;
  checkpoint: string | null;
  snapshot: AgentSnapshot;
};

/**
 * 校验用户提供的会话名称。
 * @param value 未信任的输入值。
 * @returns 去除首尾空白后的名称。
 * @throws 非文本、空白、控制字符或超过 120 字时拒绝。
 */
export function conversationTitle(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > 120 ||
    Array.from(value).some((character) => character.charCodeAt(0) < 32)
  )
    throw new Error("会话名称需要 1–120 个字符，不能包含控制字符");
  return value.trim();
}

function parseOrigin(value: unknown): ConversationOrigin | null {
  if (value === null) return null;
  const origin = record(value);
  const source = text(origin, "conversationId");
  const turnId = origin["turnId"] === null ? null : text(origin, "turnId");
  if (!conversationId.test(source) || (turnId !== null && (!turnId || turnId.length > 128)))
    throw new Error("对话来源无效");
  return { conversationId: source, title: conversationTitle(origin["title"]), turnId };
}

function parseConversation(value: unknown): ConversationRecord {
  const item = record(value);
  if (
    item["version"] !== 1 &&
    item["version"] !== 2 &&
    item["version"] !== 3 &&
    item["version"] !== 4 &&
    item["version"] !== 5 &&
    item["version"] !== 6
  )
    throw new Error("对话记录版本不支持");
  const id = text(item, "id");
  if (!conversationId.test(id)) throw new Error("对话标识无效");
  const storedSnapshot = record(item["snapshot"]);
  const snapshot = parseSnapshot(
    JSON.stringify(
      item["version"] === 1
        ? { ...storedSnapshot, turns: storedSnapshot["turns"] ?? [] }
        : storedSnapshot,
    ),
  );
  if (snapshot.id !== id) throw new Error("对话快照归属不一致");
  const draft = text(item, "draft");
  if (draft.length > 128 * 1024) throw new Error("对话草稿超过限制");
  const checkpoint =
    (item["version"] === 5 || item["version"] === 6) && item["checkpoint"] === null
      ? null
      : text(item, "checkpoint");
  if (checkpoint !== null) {
    const saved = record(parsePrivateJson(checkpoint, "对话检查点"));
    if (
      (saved["version"] !== 1 && saved["version"] !== 2) ||
      saved["workspace"] !== snapshot.workspace
    )
      throw new Error("对话历史版本或工作目录不一致");
  } else if (
    snapshot.messages.length ||
    snapshot.turns.length ||
    snapshot.run !== null ||
    item["model"] !== null
  ) {
    throw new Error("已有运行历史的对话不能缺少检查点");
  }
  let article: ArticleBinding | null = null;
  if (
    (item["version"] === 3 ||
      item["version"] === 4 ||
      item["version"] === 5 ||
      item["version"] === 6) &&
    item["article"] !== null
  ) {
    const value = record(item["article"]);
    const path = text(value, "path");
    const markerId = text(value, "markerId");
    articleConversationHref(markerId);
    if (!isEntryPath(path) || !path.toLowerCase().endsWith(".md")) throw new Error("文章路径无效");
    article = { path, markerId, title: text(value, "title") };
    if (value["removed"] !== undefined) article.removed = boolean(value, "removed");
  }
  // 旧连接和密文已经不参与恢复，只读取展示元数据，避免过期认证阻断历史迁移。
  const linkedWorkspace =
    item["version"] === 6
      ? item["linkedWorkspace"] === null
        ? null
        : text(item, "linkedWorkspace")
      : snapshot.workspace;
  if (linkedWorkspace !== null && linkedWorkspace !== snapshot.workspace)
    throw new Error("关联目录与运行目录不一致");
  if (article !== null && linkedWorkspace === null) throw new Error("文章关联必须包含所属笔记库");
  const model =
    (item["version"] === 5 || item["version"] === 6) && item["model"] === null
      ? null
      : item["version"] === 4 || item["version"] === 5 || item["version"] === 6
        ? text(item, "model")
        : text(record(record(item["model"])["settings"]), "model");
  if (model !== null && (!model.trim() || model.length > 8192)) throw new Error("历史模型标识无效");
  return {
    id,
    title: conversationTitle(item["title"]),
    createdAt: integer(item, "createdAt"),
    updatedAt: integer(item, "updatedAt"),
    archived: boolean(item, "archived"),
    origin: item["version"] === 1 ? null : parseOrigin(item["origin"]),
    article,
    linkedWorkspace,
    draft,
    model,
    modelSelection:
      (item["version"] === 5 || item["version"] === 6) && item["modelSelection"] !== null
        ? parseModelSelection(item["modelSelection"])
        : null,
    checkpoint,
    snapshot,
  };
}

/** 每条对话独立原子替换，顺序队列保证删除不会被迟到写入复活。 */
export class ConversationStore {
  private readonly directory: string;
  private writing: Promise<void> = Promise.resolve();
  /** @param userData 应用私有数据目录；构造时不读写磁盘，也不抛出存储异常。 */
  constructor(
    userData: string,
    private readonly credentialsDirectory?: string,
  ) {
    this.directory = join(userData, "conversations");
  }

  /**
   * 读取独立记录；损坏条目保留原文件并上报，其他条目继续可用。
   * @returns 有效记录与逐文件的问题清单；目录尚不存在时返回空列表。
   * @throws 目录不可访问时拒绝，避免把读取失败误认为没有历史。
   */
  async load(): Promise<{ records: ConversationRecord[]; issues: string[]; legacyIds: string[] }> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return { records: [], issues: [], legacyIds: [] };
      throw error;
    }
    const records: ConversationRecord[] = [];
    const issues: string[] = [];
    const legacyIds: string[] = [];
    for (const name of names.filter((name) => name.endsWith(".json"))) {
      try {
        if (this.credentialsDirectory && (await lstat(join(this.directory, name))).isSymbolicLink())
          throw new Error("库内对话记录不能是符号链接");
        const value = record(
          parsePrivateJson(await readFile(join(this.directory, name), "utf8"), "对话记录"),
        );
        const item = parseConversation(value);
        if (name !== `${item.id}.json`) throw new Error("文件名与对话标识不一致");
        records.push(item);
        if (value["version"] !== 5 && value["version"] !== 6) legacyIds.push(item.id);
      } catch (error) {
        issues.push(`${name}：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { records, issues, legacyIds };
  }

  /**
   * 私有权限临时文件写完再替换，失败时保留上一份完整记录。
   * @param item 已校验身份的完整会话；调用时即序列化，后续内存修改不影响本次写入。
   * @returns 原子替换成功后兑现。
   * @throws 身份无效、序列化或文件操作失败时拒绝。
   */
  save(item: ConversationRecord): Promise<void> {
    const destination = this.path(item.id);
    const content = JSON.stringify({
      version: 6,
      ...item,
    });
    return this.enqueue(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await this.replace(destination, content);
      // 新版历史不再持有认证，成功保存后清理旧版本机认证副本。
      if (this.credentialsDirectory)
        await rm(join(this.credentialsDirectory, `${item.id}.json`), { force: true });
    });
  }

  /**
   * 等待此前写入后删除指定记录。
   * @param id 持久化会话标识，禁止把路径作为身份传入。
   * @returns 文件删除后兑现，已不存在也视为成功。
   * @throws 身份无效或文件删除失败时拒绝。
   */
  remove(id: string): Promise<void> {
    const destination = this.path(id);
    return this.enqueue(async () => {
      if (this.credentialsDirectory)
        await rm(join(this.credentialsDirectory, `${id}.json`), { force: true });
      await rm(destination, { force: true });
    });
  }

  private path(id: string): string {
    if (!conversationId.test(id)) throw new Error("对话标识无效");
    return join(this.directory, `${id}.json`);
  }

  private async replace(destination: string, content: string): Promise<void> {
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.writing.then(operation);
    // 队列只负责次序；返回的原始 Promise 仍向调用方传播写入失败。
    this.writing = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
