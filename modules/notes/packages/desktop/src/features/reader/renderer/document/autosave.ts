/**
 * 自动保存：停键 2 秒或持续编辑 10 秒后提交，组词期间暂停，写盘始终串行。
 */

/** 停键后写盘的等待（毫秒），对齐 Obsidian `requestSave`。 */
export const AUTOSAVE_DELAY_MS = 2000;

/** 持续输入的最长等待（毫秒）；组词或在途写盘可延后提交，但不能重置编辑期限。 */
const AUTOSAVE_MAX_DELAY_MS = 10000;

/** `createAutosave` 的依赖。 */
export type AutosaveOptions = {
  /** 当前缓冲是否相对上次成功写盘仍有未保存改动。 */
  isDirty: () => boolean;
  /** 执行一次写盘；失败时调用方应保持 dirty。 */
  save: () => Promise<void>;
  /** 停键等待；默认 {@link AUTOSAVE_DELAY_MS}。 */
  delayMs?: number;
};

/** 自动保存控制器。 */
export type AutosaveController = {
  /** 有改动：从这次按键重新开始停键计时。写盘中也重新计时，不丢掉这段输入。 */
  touch: () => void;
  /** 取消计时并立刻保存；若正在写则等写完，仍脏再写一次。 */
  flush: () => Promise<void>;
  /** 暂停自动及手动提交，保留最早编辑时间；用于组词和副本交接。 */
  pause: () => void;
  /** 恢复计时；已经超期的编辑在下一次调度提交，不在组词事件内部写盘。 */
  resume: () => void;
  /** 释放计时器并取消排队但尚未开始的提交；控制器不再使用。 */
  dispose: () => void;
};

/**
 * 创建自动保存调度。
 *
 * @param options 脏检查与写盘。
 * @returns 供编辑器外壳调用的控制器。
 */
export function createAutosave(options: AutosaveOptions): AutosaveController {
  const delayMs = options.delayMs ?? AUTOSAVE_DELAY_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain = Promise.resolve();
  let firstEditAt: number | null = null;
  let paused = false;
  let disposed = false;
  let automaticQueued = false;

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function enqueue(work: () => Promise<void>): Promise<void> {
    const run = chain.then(work, work);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function saveCurrent(): Promise<void> {
    automaticQueued = false;
    if (disposed || paused) return;
    clearTimer();
    // 以本次快照为分界；在途写盘期间的新输入会建立下一轮期限。
    firstEditAt = null;
    if (options.isDirty()) await options.save();
  }

  function arm(): void {
    clearTimer();
    if (disposed || paused || automaticQueued || firstEditAt === null) return;
    const wait = Math.min(delayMs, Math.max(0, firstEditAt + AUTOSAVE_MAX_DELAY_MS - Date.now()));
    timer = setTimeout(() => {
      timer = null;
      automaticQueued = true;
      void enqueue(saveCurrent);
    }, wait);
  }

  return {
    touch(): void {
      if (disposed) return;
      firstEditAt ??= Date.now();
      arm();
    },
    flush(): Promise<void> {
      clearTimer();
      return enqueue(saveCurrent);
    },
    pause(): void {
      paused = true;
      clearTimer();
    },
    resume(): void {
      if (disposed) return;
      paused = false;
      if (options.isDirty()) firstEditAt ??= Date.now();
      else firstEditAt = null;
      arm();
    },
    dispose(): void {
      disposed = true;
      firstEditAt = null;
      clearTimer();
    },
  };
}
