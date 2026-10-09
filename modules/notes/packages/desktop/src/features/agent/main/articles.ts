import { lstat, readFile, realpath } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { ConversationStore, type ConversationRecord } from "./conversations";
import { locateArticle, type ArticleLocation } from "../shared/article";
import { isEntryPath } from "../../reader/shared/file-browser";

/** 库内文章历史与本机认证分开保存；已打开的库可继续服务其文章对话。 */
export class ArticleLibrary {
  private readonly stores = new Map<string, ConversationStore>();
  private lastLocation: { key: string; source: string | null; location: ArticleLocation } | null =
    null;
  /** 绑定本机认证目录，不读写笔记库。 */
  constructor(private readonly userData: string) {}

  /** 绑定真实库根，拒绝配套数据目录的符号链接；不创建空目录，路径错误抛出。 */
  async store(root: string): Promise<ConversationStore> {
    if ((await realpath(root)) !== root) throw new Error("请使用当前笔记库的规范路径");
    for (const path of [
      join(root, ".noemori"),
      join(root, ".noemori", "agent"),
      join(root, ".noemori", "agent", "conversations"),
    ]) {
      try {
        const info = await lstat(path);
        if (!info.isDirectory() || info.isSymbolicLink())
          throw new Error("文章对话目录必须是库内真实目录");
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
    let store = this.stores.get(root);
    if (!store) {
      store = new ConversationStore(
        join(root, ".noemori", "agent"),
        join(this.userData, "article-models"),
      );
      this.stores.set(root, store);
    }
    return store;
  }

  /** 核对当前文章位置；不存在返回失效状态，权限和读取错误抛出。 */
  async location(item: ConversationRecord): Promise<ArticleLocation | null> {
    if (!item.article) return null;
    if (item.article.removed) return locateArticle(item.article, null);
    const source = await this.read(item.snapshot.workspace, item.article.path);
    const key = JSON.stringify([item.snapshot.workspace, item.article]);
    // 流式回复频繁请求快照；正文未变时复用定位结果，仍读取磁盘以核对实际内容。
    if (this.lastLocation?.key === key && this.lastLocation.source === source)
      return this.lastLocation.location;
    const location = locateArticle(item.article, source);
    this.lastLocation = { key, source, location };
    return location;
  }

  /** 读取库内 Markdown；不存在返回 null，越界、权限或大小错误抛出。 */
  async read(root: string, path: string): Promise<string | null> {
    if (!isEntryPath(path) || !path.toLowerCase().endsWith(".md"))
      throw new Error("文章必须是库内 Markdown 文件");
    try {
      const absolute = await realpath(join(root, path));
      const rel = relative(root, absolute);
      if (rel.startsWith("../") || isAbsolute(rel)) throw new Error("文章路径越出笔记库");
      const info = await lstat(absolute);
      if (!info.isFile() || info.size > 32 * 1024 * 1024)
        throw new Error("文章不是文件或超过 32 MiB");
      return await readFile(absolute, "utf8");
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
