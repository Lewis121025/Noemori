import type { VaultEntry } from "../../shared/api";
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
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<boolean> = Promise.resolve(true);
  private epoch = 0;

  /** 保存函数必须核对 root，不能把旧库的延迟写入应用到新库。 */
  constructor(
    private root: () => string | null,
    private save: (root: string, state: FileTreeState) => Promise<void>,
    private report: (message: string) => void,
  ) {}

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
    this.initialized = true;
  }

  /** 切库及卸载时取消尚未派发的写入；已派发请求由主进程核对库归属。 */
  reset(): void {
    this.epoch += 1;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.dirty = false;
    this.initialized = false;
    this.remembered = false;
    this.value = emptyFileTreeState();
    this.writing = Promise.resolve(true);
  }

  /** 更新选择、展开或滚动锚点；不变的状态不会重复排队写盘。 */
  update(patch: Partial<FileTreeState>): void {
    const next = { ...this.value, ...patch };
    const samePaths = (left: string[], right: string[]) =>
      left === right ||
      (left.length === right.length && left.every((path, index) => path === right[index]));
    if (
      next.focused === this.value.focused &&
      next.scroll?.path === this.value.scroll?.path &&
      next.scroll?.offset === this.value.scroll?.offset &&
      samePaths(next.expanded, this.value.expanded) &&
      samePaths(next.selected, this.value.selected)
    )
      return;
    this.value = next;
    if (!this.initialized || this.root() === null) return;
    this.dirty = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.flush();
    }, 180);
  }

  /** 文件变化按同一映射迁移全部现场，提交后、清单刷新前调用。 */
  remap(map: (path: string) => string | null): void {
    this.update(mapFileTreeState(this.value, map));
  }

  /** 外部变更仅删除失效条目，不把新文件自动加入既有多选。 */
  reconcile(entries: readonly VaultEntry[]): void {
    if (this.initialized) this.update(reconcileFileTreeState(this.value, entries));
  }

  /** 立即发送最新现场；返回是否成功，失败原因已交给工作区显示。 */
  flush(): Promise<boolean> {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const root = this.root();
    if (!this.dirty || root === null) return this.writing;
    this.dirty = false;
    const snapshot = structuredClone(this.value);
    const epoch = this.epoch;
    this.writing = this.writing.then(async () => {
      if (epoch !== this.epoch || this.root() !== root) return true;
      try {
        await this.save(root, snapshot);
        return true;
      } catch (error) {
        if (epoch === this.epoch && this.root() === root) {
          this.dirty = true;
          this.report(
            `目录状态未能保存：${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return false;
      }
    });
    return this.writing;
  }
}
