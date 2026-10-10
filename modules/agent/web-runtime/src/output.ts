import type { Writable } from "node:stream";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 控制输出只在成功交付完整帧后完成；首个管道错误终结会话，原始原因保留在 cause 中。 */
export class ControlOutput {
  private readonly stopped = new AbortController();
  private readonly pending = new Set<(error: Error) => void>();
  private failure: Error | undefined;

  /** @param stream 会话独占的控制输出；error 事件与写入回调遵守同一失败契约。 */
  constructor(private readonly stream: Writable) {
    stream.on("error", (error: Error) => this.stop(error));
  }

  /** 输出失效后通知调用方停止输入、取消操作并回收已取得资源。 */
  get signal(): AbortSignal {
    return this.stopped.signal;
  }

  /** 首个输出失败；后续失败不能覆盖宿主断开的原始原因。 */
  get error(): Error | undefined {
    return this.failure;
  }

  /**
   * 交付一条 JSON 控制帧，不允许失败后的通道继续接受帧。
   * @param value 可序列化的完整协议消息。
   * @returns 写入回调确认成功后完成。
   * @throws 序列化错误，或包含原始写入原因的控制输出错误。
   */
  async write(value: unknown): Promise<void> {
    if (this.failure) throw this.failure;
    const frame = JSON.stringify(value) + "\n";
    await new Promise<void>((resolve, reject) => {
      this.pending.add(reject);
      const completed = (error?: Error | null) => {
        this.pending.delete(reject);
        if (error) reject(this.stop(error));
        else if (this.failure) reject(this.failure);
        else resolve();
      };
      try {
        this.stream.write(frame, completed);
      } catch (error) {
        this.pending.delete(reject);
        reject(this.stop(error));
      }
    });
  }

  /**
   * 最终失败通过仍可用的控制输出提交；死管道仅经 stderr 诊断，避免再次写入。
   * @param error 会话失败，包括操作、清理或控制输出的原始原因。
   * @returns 失败已交付或明确记录；调用方仍须以失败状态结束会话。
   */
  async reportFailure(error: unknown): Promise<void> {
    const diagnostic = message(error);
    if (!this.failure) {
      try {
        await this.write({ kind: "failed", error: diagnostic.slice(0, 4096) });
        return;
      } catch (deliveryError) {
        console.error(`${diagnostic}；${message(deliveryError)}`);
        return;
      }
    }
    console.error(
      diagnostic === this.failure.message ? diagnostic : `${diagnostic}；${this.failure.message}`,
    );
  }

  private stop(error: unknown): Error {
    if (!this.failure) {
      this.failure = new Error(`控制输出失败：${message(error)}`, { cause: error });
      for (const reject of this.pending) reject(this.failure);
      this.pending.clear();
      this.stopped.abort(this.failure);
    }
    return this.failure;
  }
}
