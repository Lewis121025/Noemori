/** 持续变化也须定期保存阅读现场；后台写入、组词及导航可延后本次提交。 */
export const SESSION_MAX_DELAY_MS = 2000;

/** 会话写入依赖；捕获最新状态由所有者负责，调度器不持有历史快照。 */
type SessionWriteOptions = {
  /** 停止变化后的合并时间；目录与正文阅读位置采用各自的等待时间。 */
  delayMs: number;
  /** 在真正发送前检查 isCurrent，防止异步捕获跨越切库或卸载。 */
  write: (isCurrent: () => boolean) => Promise<void>;
  /** 仅报告后台提交失败；显式 flush 的异常交还调用方决定是否允许关闭。 */
  report: (error: unknown) => void;
  /** 后台捕获只在界面稳定时执行；显式 flush 由导航或关闭边界保证快照就绪。 */
  ready?: () => boolean;
};

/** 一次在途写入加一个待写标记；所有 flush 等待同一次串行排空。 */
export type SessionWrite = {
  /** 标记最新状态待写；连续变化不创建 Promise 链或复制旧快照。 */
  request: () => void;
  /** 立即排空最新待写状态；持久化失败时拒绝，保留待写标记供重试。 */
  flush: () => Promise<void>;
  /** 导航、组词结束后恢复尚未提交的后台保存。 */
  resume: () => void;
  /** 取消旧归属尚未发送的状态，已发送操作仍按原顺序完成。 */
  reset: () => void;
  /** 卸载后不再捕获或调度；正常关闭须先等待 flush。 */
  dispose: () => void;
};

/**
 * 创建阅读现场的有界写入调度。
 * @param options 最新状态提交、后台失败报告与界面就绪条件。
 * @returns 可合并变化、等待提交及取消旧归属的控制器。
 */
export function createSessionWrite(options: SessionWriteOptions): SessionWrite {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let writing: Promise<void> | null = null;
  let pending = false;
  let forced = false;
  let disposed = false;
  let generation = 0;
  let firstChangeAt: number | null = null;
  const ready = () => options.ready?.() ?? true;

  function clearTimer(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function arm(): void {
    clearTimer();
    if (disposed || !pending || writing !== null || !ready()) return;
    const remaining = (firstChangeAt ?? Date.now()) + SESSION_MAX_DELAY_MS - Date.now();
    timer = setTimeout(
      () => {
        timer = null;
        const epoch = generation;
        void run(false).catch((error: unknown) => {
          if (!disposed && epoch === generation) options.report(error);
        });
      },
      Math.min(options.delayMs, Math.max(0, remaining)),
    );
  }

  function run(force: boolean): Promise<void> {
    clearTimer();
    if (disposed || (!pending && writing === null)) return Promise.resolve();
    forced ||= force;
    if (writing !== null) return writing;
    writing = Promise.resolve().then(async () => {
      let failed = false;
      try {
        while (pending && !disposed && (forced || ready())) {
          const epoch = generation;
          pending = false;
          firstChangeAt = null;
          try {
            await options.write(() => !disposed && epoch === generation);
          } catch (error) {
            if (!disposed && epoch === generation) {
              pending = true;
              firstChangeAt = null;
              failed = true;
              throw error;
            }
          }
          // 后台保存继续遵守合并时间；显式冲刷必须等到期间产生的新状态也提交。
          if (!forced) break;
        }
      } finally {
        writing = null;
        forced = false;
        if (!failed) arm();
      }
    });
    return writing;
  }

  function reset(): void {
    generation += 1;
    pending = false;
    forced = false;
    firstChangeAt = null;
    clearTimer();
  }

  return {
    request() {
      if (disposed) return;
      pending = true;
      firstChangeAt ??= Date.now();
      arm();
    },
    flush: () => run(true),
    resume: arm,
    reset,
    dispose() {
      reset();
      disposed = true;
    },
  };
}
