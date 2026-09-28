/**
 * 关窗口冲刷闸门：避免过期的 close/quit 交错，也避免渲染进程接不住时永远卡住。
 */

/** 窗口关闭与退出共享的闸门。 */
export type CloseGate = {
  /** 为真时允许原生关闭继续。 */
  allow: boolean;
  /** 这次冲刷来自退出（Cmd-Q），成功后应 `app.quit`。 */
  quit: boolean;
  /** 已向渲染进程发出冲刷，尚未得到结果。 */
  flushing: boolean;
};

/**
 * 新建闸门。
 *
 * @returns 初始为未放行、未退出、未冲刷。
 */
export function createCloseGate(): CloseGate {
  return { allow: false, quit: false, flushing: false };
}

/** 一次关闭尝试的处置。 */
export type CloseAttemptAction = "proceed" | "prevent-and-send" | "prevent-quiet";

/** 冲刷完成后的处置。 */
export type FlushResultAction = "quit" | "close" | "stay";

/**
 * 窗口 `close` 或应用 `before-quit`。
 *
 * 渲染进程尚未就绪时放行，否则会永远 `preventDefault`。
 * 已在冲刷中则只更新 quit 标记，不再重复发送。
 *
 * @param gate 共享闸门。
 * @param opts.asQuit 是否来自退出。
 * @param opts.rendererReady 渲染进程能否收到 `flushBeforeClose`。
 * @returns 放行、拦截并发送、或拦截但不再发送。
 */
export function onCloseAttempt(
  gate: CloseGate,
  opts: { asQuit: boolean; rendererReady: boolean },
): CloseAttemptAction {
  if (gate.allow) {
    return "proceed";
  }
  if (!opts.rendererReady) {
    return "proceed";
  }
  if (opts.asQuit) {
    gate.quit = true;
  }
  if (gate.flushing) {
    return "prevent-quiet";
  }
  gate.flushing = true;
  return "prevent-and-send";
}

/**
 * 渲染进程冲刷结束。
 *
 * @param gate 共享闸门。
 * @param saved 缓冲已干净。
 * @returns 退出、关窗或留着。
 */
export function onFlushResult(gate: CloseGate, saved: boolean): FlushResultAction {
  gate.flushing = false;
  if (!saved) {
    gate.quit = false;
    return "stay";
  }
  gate.allow = true;
  return gate.quit ? "quit" : "close";
}

/**
 * 新建窗口时复位闸门。
 *
 * @param gate 共享闸门。
 */
export function resetCloseGate(gate: CloseGate): void {
  gate.allow = false;
  gate.quit = false;
  gate.flushing = false;
}
