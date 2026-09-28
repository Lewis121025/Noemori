import type { Bookmark, ReaderApi } from "../../shared/api";
import { moveBookmark, sameBookmark, toggleBookmark } from "../engine/navigation/bookmarks";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 当前库的书签清单。
 *
 * 修改先乐观更新界面再整表写回库内文件；读写共用一个请求序号，
 * 修改开始后在途的旧读取结果直接丢弃，不会把刚改的清单覆盖回去。
 * 切库必须 `reset`，避免旧库书签串到新库。
 */
export class ReaderBookmarks {
  private list = $state.raw<readonly Bookmark[]>([]);
  private failure = $state<string | null>(null);
  private request = 0;

  /** @param api 只需要书签读写；打开目标由工作区负责。 */
  constructor(private readonly api: Pick<ReaderApi, "bookmarksList" | "bookmarksSet">) {}

  /** 当前清单，按用户排列的顺序。 */
  get items(): readonly Bookmark[] {
    return this.list;
  }
  /** 读取或保存失败的原因；下一次成功读写后清除。 */
  get error(): string | null {
    return this.failure;
  }

  /** 目标是否已收藏；显示名不参与比较。 */
  has(target: Bookmark): boolean {
    return this.list.some((item) => sameBookmark(item, target));
  }

  /** 从库内文件重读；失败时清单置空并给出原因，下一次收藏会先备份损坏文件再覆盖。 */
  async reload(): Promise<void> {
    const request = ++this.request;
    try {
      const items = await this.api.bookmarksList();
      if (request !== this.request) return;
      this.list = items;
      this.failure = null;
    } catch (error) {
      if (request !== this.request) return;
      this.list = [];
      this.failure = `书签暂不可用：${errorText(error)}`;
    }
  }

  /** 丢弃清单与在途请求（切库）。 */
  reset(): void {
    this.request += 1;
    this.list = [];
    this.failure = null;
  }

  /**
   * 收藏或取消收藏。
   * @returns 操作后目标是否处于已收藏状态。
   */
  async toggle(target: Bookmark): Promise<boolean> {
    const next = toggleBookmark(this.list, target);
    await this.commit(next);
    return next.some((item) => sameBookmark(item, target));
  }

  /** 移除指向该目标的书签。 */
  remove(target: Bookmark): Promise<void> {
    return this.commit(this.list.filter((item) => !sameBookmark(item, target)));
  }

  /** 拖放重排：把 `from` 处插到 `to` 处那一行之前；顺序未变时不写盘。 */
  async move(from: number, to: number): Promise<void> {
    const next = moveBookmark(this.list, from, to);
    if (next !== this.list) await this.commit(next);
  }

  private async commit(next: readonly Bookmark[]): Promise<void> {
    const request = ++this.request;
    this.list = next;
    this.failure = null;
    try {
      await this.api.bookmarksSet([...next]);
    } catch (error) {
      if (request !== this.request) return;
      // 写入失败时以磁盘为准回退，磁盘也读不到就保留乐观结果，原因照常可见。
      const disk = await this.api.bookmarksList().catch(() => null);
      if (request !== this.request) return;
      if (disk !== null) this.list = disk;
      this.failure = `书签未能保存：${errorText(error)}`;
    }
  }
}
