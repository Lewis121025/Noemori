/**
 * 主线程侧的布局入口：Worker 实现与同步实现共用一个接口，
 * 画布组件不关心坐标从哪里算出来。
 */

import { computeLayout, type LayoutRequest } from "./layout";

/** 发给布局 Worker 的消息。 */
export type LayoutRequestMessage =
  | { readonly type: "run"; readonly id: number; readonly request: LayoutRequest }
  | { readonly type: "stop"; readonly id: number };

/** 布局 Worker 回送的一帧坐标。 */
export type LayoutFrameMessage = {
  readonly id: number;
  /** 交错排列的世界坐标 `[x0, y0, …]`。 */
  readonly positions: Float32Array;
  /** 是否为收敛后的最后一帧。 */
  readonly done: boolean;
};

/** 一帧坐标的回调；`done` 为真后同一次布局不再回调。 */
export type LayoutFrameHandler = (positions: Float32Array, done: boolean) => void;

/** 布局引擎。 */
export interface LayoutEngine {
  /**
   * 开始一次布局；新的布局会取代同一引擎上尚未结束的旧布局。
   *
   * 请求里的类型数组会被转移给 Worker，调用后不能再读写。
   * @param onError 布局无法完成时调用，之后不再回帧。
   * @returns 取消函数；取消后不再回帧。
   */
  run(
    request: LayoutRequest,
    onFrame: LayoutFrameHandler,
    onError: (message: string) => void,
  ): () => void;
  /** 释放 Worker；之后不能再调用 `run`。 */
  dispose(): void;
}

/** 在 Worker 里分帧计算的布局；Worker 在第一次布局时才创建。 */
export function createWorkerLayout(): LayoutEngine {
  let worker: Worker | null = null;
  let active: {
    id: number;
    onFrame: LayoutFrameHandler;
    onError: (message: string) => void;
  } | null = null;
  let sequence = 0;
  const start = (): Worker => {
    const created = new Worker(new URL("./layout.worker.ts", import.meta.url), { type: "module" });
    created.onmessage = (event: MessageEvent<LayoutFrameMessage>) => {
      const frame = event.data;
      if (active === null || frame.id !== active.id) return;
      const handler = active.onFrame;
      if (frame.done) active = null;
      handler(frame.positions, frame.done);
    };
    created.onerror = (event) => {
      event.preventDefault();
      const failed = active;
      active = null;
      failed?.onError(event.message || "布局线程异常退出");
      // 出错的 Worker 状态不可信，下一次布局重新创建。
      created.terminate();
      if (worker === created) worker = null;
    };
    return created;
  };
  return {
    run(request, onFrame, onError) {
      worker ??= start();
      const id = ++sequence;
      active = { id, onFrame, onError };
      const message: LayoutRequestMessage = { type: "run", id, request };
      worker.postMessage(message, [request.links.buffer, request.seeds.buffer]);
      return () => {
        if (active?.id !== id) return;
        active = null;
        const stop: LayoutRequestMessage = { type: "stop", id };
        worker?.postMessage(stop);
      };
    },
    dispose() {
      active = null;
      worker?.terminate();
      worker = null;
    },
  };
}

/** 同步跑完再一次性回帧；用于测试与不支持 Worker 的环境。 */
export function createInlineLayout(): LayoutEngine {
  return {
    run(request, onFrame, onError) {
      let cancelled = false;
      queueMicrotask(() => {
        if (cancelled) return;
        try {
          onFrame(computeLayout(request), true);
        } catch (error) {
          onError(error instanceof Error ? error.message : String(error));
        }
      });
      return () => {
        cancelled = true;
      };
    },
    dispose() {},
  };
}
