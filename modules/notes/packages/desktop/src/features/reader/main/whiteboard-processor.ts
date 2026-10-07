import { Worker } from "node:worker_threads";
import {
  parseShapeFit,
  type ShapeRepair,
  type ShapeRepairRequest,
} from "../shared/whiteboard/recognition";

/** 受窗口寿命约束的几何线程，异常与协议错误向调用方传播。 */
export type WhiteboardProcessor = { repair: ShapeRepair; close: () => Promise<void> };
/** 未完成请求独立保存输入身份，返回联动不得引用别的请求的上下文。 */
type Pending = {
  request: ShapeRepairRequest;
  resolve: (value: ReturnType<typeof parseShapeFit>) => void;
  reject: (cause: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * 在专用线程串行计算有界几何，主进程不执行数值求解；最多四个在途请求。
 * @returns 惰性启动的计算器与幂等关闭方法；关闭拒绝全部未完成请求并等待线程退出。
 * @throws 启动、超时、退出与协议错误通过repair的Promise传播；下次请求可重建故障线程。
 */
export function createWhiteboardProcessor(): WhiteboardProcessor {
  let worker: Worker | null = null,
    sequence = 0,
    closed = false,
    stopped: Promise<void> | null = null;
  const pending = new Map<number, Pending>();
  const terminate = (error: Error): Promise<void> => {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
    const current = worker;
    worker = null;
    const stopping = current
      ? current.terminate().then(() => {
          current.removeAllListeners();
        })
      : Promise.resolve();
    stopped = stopped ? Promise.all([stopped, stopping]).then(() => {}) : stopping;
    return stopped;
  };
  const close = () => {
    closed = true;
    return terminate(new Error("白板计算窗口已关闭"));
  };
  const repair: ShapeRepair = async (request) => {
    if (closed) throw new Error("白板计算窗口已关闭");
    if (pending.size >= 4) throw new Error("白板计算请求过多，请稍后停笔重试");
    if (!worker) {
      const current = new Worker(new URL("./whiteboard-worker.js", import.meta.url), {
        resourceLimits: { maxOldGenerationSizeMb: 256 },
      });
      worker = current;
      current.unref();
      current.on("message", (message: unknown) => {
        if (worker !== current) return;
        if (
          typeof message !== "object" ||
          message === null ||
          !("id" in message) ||
          typeof message.id !== "number" ||
          !Number.isSafeInteger(message.id) ||
          !("value" in message || "error" in message) ||
          ("value" in message && "error" in message)
        ) {
          void terminate(new Error("白板计算回复协议无效"));
          return;
        }
        const item = pending.get(message.id);
        if (!item) {
          void terminate(new Error("白板计算回复身份无效"));
          return;
        }
        clearTimeout(item.timer);
        pending.delete(message.id);
        try {
          if ("error" in message) {
            if (typeof message.error !== "string") throw new Error("白板计算错误回复无效");
            throw new Error(message.error);
          }
          item.resolve(parseShapeFit("value" in message ? message.value : undefined, item.request));
        } catch (cause) {
          item.reject(cause instanceof Error ? cause : new Error(String(cause)));
        }
      });
      current.once("error", (error) => {
        if (worker === current) void terminate(error);
      });
      current.once("exit", (code) => {
        if (worker === current) void terminate(new Error(`白板计算线程意外退出：${code}`));
      });
    }
    const current = worker,
      id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        void terminate(new Error("白板几何计算超时"));
      }, 10000);
      pending.set(id, { request, resolve, reject, timer });
      try {
        current.postMessage({ id, request });
      } catch (cause) {
        void terminate(cause instanceof Error ? cause : new Error(String(cause)));
      }
    });
  };
  return { repair, close };
}
