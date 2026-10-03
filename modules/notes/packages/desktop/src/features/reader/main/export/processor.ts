import { Worker } from "node:worker_threads";
import { EXPORT_LIMITS, parseExportIssues } from "../../shared/export";
import type { ExportSourceParser } from "./source-parser";
import type { ExportComputation, ExportComputationRequest } from "./computation";
import { ExportFailure } from "./errors";
import { exportByteTransfer } from "./transfer";

/** 任务专用解析线程；磁盘能力留在宿主，关闭要等待线程真正退出。 */
export type ExportProcessor = {
  parse: ExportSourceParser;
  compute: ExportComputation;
  close: () => Promise<void>;
};

/**
 * 串行处理冻结正文，取消可终止正在进行的同步 Markdown 解析。
 * @param signal 绑定导出任务与宿主窗口寿命。
 * @throws 启动、协议、解析、退出或超时错误阻止整批发布，不回退到主线程解析。
 */
export function createExportProcessor(signal: AbortSignal): ExportProcessor {
  let worker: Worker | null = null;
  let stopped: Promise<void> | null = null;
  let sequence = 0;
  let active: {
    id: number;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  } | null = null;
  let failure: Error | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = (error: Error | null, value?: unknown): void => {
    clearTimeout(timer);
    timer = undefined;
    const pending = active;
    active = null;
    if (error) pending?.reject(error);
    else pending?.resolve(value);
  };
  const close = async (): Promise<void> => {
    if (stopped) return stopped;
    failure ??= new Error("导出解析任务已关闭");
    finish(failure);
    signal.removeEventListener("abort", abort);
    const current = worker;
    worker = null;
    stopped = current
      ? current.terminate().then(() => {
          current.removeAllListeners();
        })
      : Promise.resolve();
    return stopped;
  };
  const stop = (reason: Error): void => {
    failure = reason;
    // 协调器的 finally 仍须 await close，不能在后台遗留正在解析的线程。
    void close().catch((error: unknown) => {
      failure = error instanceof Error ? error : new Error(String(error));
    });
  };
  const abort = (): void => stop(new Error("导出已取消"));
  signal.addEventListener("abort", abort, { once: true });
  const run = async (
    input: { bytes: Uint8Array } | { computation: ExportComputationRequest },
  ): Promise<unknown> => {
    signal.throwIfAborted();
    if (failure) throw failure;
    if (active) throw new Error("导出解析只能逐篇执行");
    let request = input;
    let transfer: ArrayBuffer[] = [];
    if ("bytes" in input) {
      const packet = exportByteTransfer(input.bytes);
      request = { bytes: packet.bytes };
      transfer = packet.transfer;
    } else if ("bytes" in input.computation) {
      const packet = exportByteTransfer(input.computation.bytes);
      request = { computation: { ...input.computation, bytes: packet.bytes } };
      transfer = packet.transfer;
    }
    if (!worker) {
      const current = new Worker(new URL("./export-worker.js", import.meta.url), {
        resourceLimits: { maxOldGenerationSizeMb: EXPORT_LIMITS.memoryBytes / 1024 ** 2 },
      });
      worker = current;
      current.on("message", (message: unknown) => {
        if (worker !== current || !active) return;
        if (
          typeof message !== "object" ||
          message === null ||
          !("id" in message) ||
          typeof message.id !== "number" ||
          !Number.isSafeInteger(message.id) ||
          message.id < 1
        ) {
          failure = new Error("导出解析任务响应身份无效");
          finish(failure);
          return;
        }
        if (message.id < active.id) return;
        if (
          message.id !== active.id ||
          Object.keys(message).length !== 2 ||
          "value" in message === "error" in message
        ) {
          failure = new Error("导出解析任务响应身份无效");
          finish(failure);
          return;
        }
        if ("error" in message) {
          const error = message.error;
          try {
            finish(
              typeof error === "object" && error !== null && "issues" in error
                ? new ExportFailure(parseExportIssues(error.issues))
                : new Error(typeof error === "string" ? error : "导出计算错误回复无效"),
            );
          } catch (invalid) {
            finish(invalid instanceof Error ? invalid : new Error(String(invalid)));
          }
        } else if ("value" in message) finish(null, message.value);
      });
      current.once("error", (error) => {
        failure = error;
        finish(error);
      });
      current.once("exit", (code) => {
        if (worker === current) {
          failure = new Error(`导出解析线程意外退出：${code}`);
          finish(failure);
        }
      });
    }
    const current = worker;
    return new Promise((resolve, reject) => {
      active = { id: ++sequence, resolve, reject };
      timer = setTimeout(
        () => stop(new Error("导出解析或计算超过 180 秒")),
        EXPORT_LIMITS.renderMs,
      );
      try {
        current.postMessage({ id: sequence, ...request }, transfer);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  };
  const parse: ExportSourceParser = (bytes) => run({ bytes });
  const compute: ExportComputation = (computation) => run({ computation });
  return { parse, compute, close };
}
