import type { Worker } from "node:worker_threads";
import type { CoreCommand, CoreInput, CoreOutput, CoreRequest } from "./core-protocol";
import type { CoreService } from "./core-service";
import type { VaultEvent } from "../features/reader/shared/api";

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

/**
 * 主进程的内核客户端：关联异步结果，并在退出前排空已提交的工作。
 * 线程异常后拒绝后续调用，不自动重放结果未知的写操作。
 */
export class CoreClient {
  private sequence = 0;
  private readonly pending = new Map<number, Pending>();
  private failure: Error | null = null;
  private stopping: Promise<void> | null = null;
  private readonly exited: Promise<Error | null>;
  private serviceClosed = false;

  /**
   * @param worker 唯一持有原生内核的线程。
   * @param onChanged 当前库变更通知。
   */
  constructor(
    private readonly worker: Worker,
    private readonly onChanged: (event: VaultEvent) => void,
  ) {
    worker.on("message", (message: CoreOutput) => {
      if (message.type === "stopped") {
        this.serviceClosed = true;
        return;
      }
      if (message.type === "changed") {
        if (this.failure === null && this.stopping === null) onChanged(message.event);
        return;
      }
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      this.pending.delete(message.id);
      if (message.type === "error") pending.reject(new Error(message.message));
      else pending.resolve(message.value);
    });
    worker.on("error", (error) => this.fail(error));
    // error 只表明发生故障，exit 才表示线程资源确已释放；此 Promise 不主动拒绝。
    this.exited = new Promise((resolve) => {
      worker.once("exit", (code) => {
        if (code !== 0 || !this.serviceClosed || this.pending.size !== 0) {
          this.fail(new Error(`内核线程意外退出（${code}），请重新启动应用`));
        }
        resolve(this.failure);
      });
    });
  }

  /**
   * 按调用顺序提交命令；字节通过结构化克隆传递，不转移编辑器缓冲区所有权。
   * @param command 服务命令名。
   * @param args 与命令签名一致的参数。
   * @returns 命令结果；内核错误、线程故障或停机后调用会拒绝。
   */
  call<C extends CoreCommand>(
    command: C,
    ...args: Parameters<CoreService[C]>
  ): Promise<Awaited<ReturnType<CoreService[C]>>> {
    if (this.failure !== null) return Promise.reject(this.failure);
    if (this.stopping !== null) return Promise.reject(new Error("内核正在关闭"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        // 编号只对应这一条命令，结果类型与调用签名一致。
        resolve: (value) => resolve(value as Awaited<ReturnType<CoreService[C]>>),
        reject,
      });
      const request: CoreRequest<C> = { type: "call", id, command, args };
      try {
        this.worker.postMessage(request);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  /**
   * 排空命令、停止原生监视后等待线程自然退出；重复调用共用同一结果。
   * @returns 线程已结束；异常终止时拒绝，不伪装成安全停机。
   */
  shutdown(): Promise<void> {
    if (this.stopping !== null) return this.stopping;
    this.stopping = this.exited.then((error) => {
      if (error !== null) throw error;
    });
    if (this.failure === null) {
      try {
        this.worker.postMessage({ type: "shutdown" } satisfies CoreInput);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    }
    return this.stopping;
  }

  private fail(error: Error): void {
    const first = this.failure === null;
    this.failure ??= error;
    for (const pending of this.pending.values()) pending.reject(this.failure);
    this.pending.clear();
    if (first) this.onChanged({ status: "worker-error", paths: [], message: this.failure.message });
  }
}
