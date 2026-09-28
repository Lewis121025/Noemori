import { HISTORY_LIMIT, type HistoryEntry, type SessionHistory } from "../../shared/session";
import { parseReadingBookmark } from "../../shared/reading-position";

/** 会话内的阅读栈条目：持久化形态加上滚动位置（只对本次运行有意义）。 */
export type ReadingStep = HistoryEntry & { scrollTop: number | null };

/** 滚动捕获与恢复能力，由工作区外壳绑定到真实滚动容器。 */
export type ScrollBridge = {
  /** 离开文档前记录滚动位置；容器缺席时返回 null。 */
  capture: () => number | null;
  /** 新导航提交后、挂载目标前归零，随后显式标题或搜索定位可以覆盖起点。 */
  reset: () => void;
  /** 回到文档后恢复滚动位置；异步布局完成后才结束导航门禁。 */
  apply: (top: number) => void | Promise<void>;
};

/**
 * 阅读栈：文档导航的后退/前进双栈。
 *
 * 语义与浏览器一致：新导航清空前进栈；后退把当前位置压入前进栈。
 * 正文锚点跨视图与重启恢复；无文本锚点的表面仅在当前会话保留像素滚动。
 */
export class ReaderHistory {
  private backward = $state<ReadingStep[]>([]);
  private forward = $state<ReadingStep[]>([]);
  private scroll: ScrollBridge | null = null;

  /** 绑定滚动容器；返回的解绑函数只释放本次绑定，未绑定时不捕获位置。 */
  attachScroll(scroll: ScrollBridge): () => void {
    this.scroll = scroll;
    return () => {
      if (this.scroll === scroll) this.scroll = null;
    };
  }

  /** 是否可后退。 */
  get canBack(): boolean {
    return this.backward.length > 0;
  }
  /** 是否可前进。 */
  get canForward(): boolean {
    return this.forward.length > 0;
  }

  /** 捕获当前位置为完整条目（含滚动）。 */
  captureStep(entry: HistoryEntry): ReadingStep {
    return { ...entry, scrollTop: this.scroll?.capture() ?? null };
  }

  /** 新文档从开头展示；只在加载成功后的新导航中调用，重载与改名保留原位置。 */
  resetScroll(): void {
    this.scroll?.reset();
  }

  /** 新导航入栈：清空前进栈，超限丢最旧。 */
  pushStep(step: ReadingStep): void {
    this.backward = [...this.backward, step].slice(-HISTORY_LIMIT);
    this.forward = [];
  }

  /** 后退目标（不出栈）；门禁通过后由 `commitBack` 提交。 */
  peekBack(): ReadingStep | null {
    return this.backward[this.backward.length - 1] ?? null;
  }

  /** 前进目标（不出栈）；门禁通过后由 `commitForward` 提交。 */
  peekForward(): ReadingStep | null {
    return this.forward[0] ?? null;
  }

  /** 提交后退：目标出后退栈，当前位置入前进栈。 */
  commitBack(current: ReadingStep): void {
    this.backward = this.backward.slice(0, -1);
    this.forward = [current, ...this.forward].slice(0, HISTORY_LIMIT);
  }

  /** 提交前进：目标出前进栈，当前位置入后退栈。 */
  commitForward(current: ReadingStep): void {
    this.forward = this.forward.slice(1);
    this.backward = [...this.backward, current].slice(-HISTORY_LIMIT);
  }

  /** 恢复离开时的阅读位置；没有现场记录或滚动容器时返回 false，供导航回退到锚点。 */
  async applyScroll(step: ReadingStep): Promise<boolean> {
    if (step.scrollTop === null || this.scroll === null) return false;
    await this.scroll.apply(step.scrollTop);
    return true;
  }

  /**
   * 改名/移动后的路径跟随；`to === null`（删除）时移除受影响条目。
   * 目录前缀整体迁移，与文件栏的路径跟随同一语义。
   */
  remapPath(from: string, to: string | null): void {
    const remap = (step: ReadingStep): ReadingStep | null => {
      if (step.path === from) return to === null ? null : { ...step, path: to };
      if (step.path.startsWith(`${from}/`))
        return to === null ? null : { ...step, path: `${to}${step.path.slice(from.length)}` };
      return step;
    };
    const apply = (steps: ReadingStep[]): ReadingStep[] =>
      steps.flatMap((step) => {
        const mapped = remap(step);
        return mapped === null ? [] : [mapped];
      });
    this.backward = apply(this.backward);
    this.forward = apply(this.forward);
  }

  /** 清空双栈；切库时使用。 */
  clear(): void {
    this.backward = [];
    this.forward = [];
  }

  /** 持久化快照：剥离像素滚动，并将响应式正文锚点复制为可跨 IPC 的普通数据。 */
  snapshot(): SessionHistory {
    const strip = (steps: ReadingStep[]): HistoryEntry[] =>
      steps.map(({ path, anchor, position }) => {
        const saved = parseReadingBookmark(position);
        return { path, anchor, ...(saved === null ? {} : { position: saved }) };
      });
    return { back: strip(this.backward), forward: strip(this.forward) };
  }

  /**
   * 从会话恢复；按当前文件列表过滤失效条目。
   *
   * @param history 会话里的持久化形态。
   * @param exists 路径是否仍存在于当前库。
   */
  restore(history: SessionHistory, exists: (path: string) => boolean): void {
    const filter = (entries: readonly HistoryEntry[]): ReadingStep[] =>
      entries.filter((entry) => exists(entry.path)).map((entry) => ({ ...entry, scrollTop: null }));
    this.backward = filter(history.back).slice(-HISTORY_LIMIT);
    this.forward = filter(history.forward).slice(0, HISTORY_LIMIT);
  }
}
