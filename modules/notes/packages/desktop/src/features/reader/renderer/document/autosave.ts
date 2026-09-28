/**
 * 停键自动保存：2 秒闲置后写盘，切走时冲刷，写盘不重叠。
 */

/** 停键后写盘的等待（毫秒），对齐 Obsidian `requestSave`。 */
export const AUTOSAVE_DELAY_MS = 2000;

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
  /** 取消未触发的计时。 */
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

  function armIdle(): void {
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      void enqueue(async () => {
        if (options.isDirty()) {
          await options.save();
        }
      });
    }, delayMs);
  }

  return {
    touch(): void {
      armIdle();
    },
    flush(): Promise<void> {
      clearTimer();
      return enqueue(async () => {
        if (options.isDirty()) {
          await options.save();
        }
      });
    },
    dispose(): void {
      clearTimer();
    },
  };
}
