import type { VaultEntry } from "../../shared/api";
import { createSessionWrite, type SessionWrite } from "../session-write";
import { ancestorDirectories } from "./file-tree";
import {
  emptyFileTreeState,
  mapFileTreeState,
  parseFileTreeState,
  reconcileFileTreeState,
  type FileTreeState,
} from "../../shared/file-browser";

/**
 * 文件树唯一状态源；合并高频滚动写入，切库取消旧任务，关闭时显式冲刷。
 * 持久化失败可见上报，内存中的选择与展开不因磁盘故障丢失。
 */
export class ReaderFileTree {
  private value = $state.raw<FileTreeState>(emptyFileTreeState());
  private initialized = $state(false);
  private remembered = false;
  private readonly writing: SessionWrite;
  private epoch = 0;
  private searchOrigin: FileTreeState | null = null;

  /** 保存函数必须核对 root，不能把旧库的延迟写入应用到新库。 */
  constructor(
    private root: () => string | null,
    private save: (root: string, state: FileTreeState) => Promise<void>,
    private report: (message: string) => void,
  ) {
    this.writing = createSessionWrite({
      delayMs: 180,
      write: async (isCurrent) => {
        const root = this.root();
        if (!this.initialized || root === null || !isCurrent()) return;
        await this.save(root, structuredClone(this.value));
      },
      report: (error) => this.reportFailure(error),
    });
  }

  private reportFailure(error: unknown): void {
    this.report(`目录状态未能保存：${error instanceof Error ? error.message : String(error)}`);
  }

  /** 当前内存现场，调用方只能通过 update 更新。 */
  get state(): FileTreeState {
    return this.value;
  }
  /** 清单与会话都恢复后才允许视图自动定位和写入。 */
  get ready(): boolean {
    return this.initialized;
  }
  /** 区分用户保存的折叠选择与首次打开时的默认定位。 */
  get hasStoredState(): boolean {
    return this.remembered;
  }

  /** 从同一库的清单恢复有效路径；非法或旧会话回到空状态。 */
  restore(state: FileTreeState | null, entries: readonly VaultEntry[]): void {
    this.reset();
    const parsed = parseFileTreeState(state);
    this.remembered = parsed !== null;
    this.value = reconcileFileTreeState(parsed ?? emptyFileTreeState(), entries);
    if (this.value.browse?.query.trim())
      this.searchOrigin = { ...this.value, browse: { ...this.value.browse, query: "" } };
    this.initialized = true;
  }

  /** 切库及卸载时取消尚未派发的写入；已派发请求由主进程核对库归属。 */
  reset(): void {
    this.searchOrigin = null;
    this.epoch += 1;
    this.writing.reset();
    this.initialized = false;
    this.remembered = false;
    this.value = emptyFileTreeState();
  }

  /** 更新选择、展开或滚动锚点；不变的状态不会重复排队写盘。 */
  update(patch: Partial<FileTreeState>): void {
    const next = { ...this.value, ...patch };
    const samePaths = (left: string[], right: string[]) =>
      left === right ||
      (left.length === right.length && left.every((path, index) => path === right[index]));
    if (
      next.presentation?.layout === this.value.presentation?.layout &&
      next.presentation?.sort === this.value.presentation?.sort &&
      next.presentation?.preview === this.value.presentation?.preview &&
      next.browse?.query === this.value.browse?.query &&
      next.browse?.section === this.value.browse?.section &&
      next.browse?.directory === this.value.browse?.directory &&
      next.focused === this.value.focused &&
      next.scroll?.path === this.value.scroll?.path &&
      next.scroll?.offset === this.value.scroll?.offset &&
      next.navigationScroll?.path === this.value.navigationScroll?.path &&
      next.navigationScroll?.offset === this.value.navigationScroll?.offset &&
      samePaths(next.expanded, this.value.expanded) &&
      samePaths(next.selected, this.value.selected)
    )
      return;
    this.value = next;
    if (!this.initialized || this.root() === null) return;
    this.writing.request();
  }

  /**
   * 目录切换原子清除之前的选择、查询和滚动锚点，保留其他分支的展开状态。
   * @param path 当前库中已存在的相对目录，空字符串表示库根。
   * @returns 不返回值；未恢复的会话不操作，持久化失败经既有错误通道报告。
   */
  enterDirectory(path: string): void {
    if (!this.initialized) return;
    this.searchOrigin = null;
    const ancestors = path === "" ? [] : [...ancestorDirectories(path), path];
    this.update({
      browse: { query: "", section: "files", directory: path },
      expanded: [
        ...this.value.expanded,
        ...ancestors.filter((ancestor) => !this.value.expanded.includes(ancestor)),
      ],
      selected: [],
      focused: null,
      scroll: null,
    });
  }

  /** 文件变化按同一映射迁移全部现场，提交后、清单刷新前调用。 */
  remap(map: (path: string) => string | null): void {
    if (this.searchOrigin) this.searchOrigin = mapFileTreeState(this.searchOrigin, map);
    this.update(mapFileTreeState(this.value, map));
  }

  /** 外部变更仅删除失效条目，不把新文件自动加入既有多选。 */
  reconcile(entries: readonly VaultEntry[]): void {
    if (this.searchOrigin) this.searchOrigin = reconcileFileTreeState(this.searchOrigin, entries);
    if (this.initialized) this.update(reconcileFileTreeState(this.value, entries));
  }

  /**
   * 搜索临时接管选择与滚动；退出时恢复浏览现场，改名和删除同步映射该现场。
   * @param query 已完成输入法组词的查询文本；空白退出搜索。
   * @returns 无返回值；未恢复时不操作，持久化错误由既有报告通道处理。
   */
  setQuery(query: string): void {
    if (!this.initialized || query === this.value.browse?.query) return;
    const browse = this.value.browse ?? { query: "", section: "files", directory: "" };
    if (!browse.query.trim() && query.trim()) this.searchOrigin = structuredClone(this.value);
    if (!query.trim() && this.searchOrigin) {
      const origin = this.searchOrigin;
      this.searchOrigin = null;
      this.update({
        expanded: origin.expanded,
        selected: origin.selected,
        focused: origin.focused,
        scroll: origin.scroll,
        browse: { ...(origin.browse ?? browse), query: "", section: "files" },
      });
    } else {
      this.update({ browse: { ...browse, query, section: "files" }, selected: [], focused: null });
    }
  }

  /** 立即发送最新现场；返回是否成功，失败原因已交给工作区显示。 */
  async flush(): Promise<boolean> {
    const epoch = this.epoch;
    try {
      await this.writing.flush();
      return true;
    } catch (error) {
      if (epoch !== this.epoch) return true;
      this.reportFailure(error);
      return false;
    }
  }
}
