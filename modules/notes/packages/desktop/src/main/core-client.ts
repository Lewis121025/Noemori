import type { NativeControl } from "@noemori/vault-node";
import { createCoreService, type CoreService } from "./core-service";
import type { VaultEvent } from "../features/reader/shared/api";

/** 主进程的薄客户端；原生同步入队确定顺序，Promise 仅交付最终结果。 */
export class CoreClient {
  private readonly service: ReturnType<typeof createCoreService>;
  private readonly pending = new Set<Promise<unknown>>();
  private stopping: Promise<void> | null = null;

  /** 创建当前应用的运行时；加载错误直接传播，不启动部分可用的内核。 */
  constructor(userData: string, onChanged: (event: VaultEvent) => void) {
    this.service = createCoreService(userData, (event) => {
      if (this.stopping === null) onChanged(event);
    });
  }

  /** 创建独立控制句柄；进度读取与取消均不访问磁盘或命令队列。 */
  createControl(): NativeControl {
    return this.service.createControl();
  }

  /**
   * 按调用顺序进入 Rust；不转移或分离编辑器输入缓冲区。
   * @returns 对应命令的结果；失败传播，禁止自动重放写入。
   */
  call<C extends keyof CoreService>(
    command: C,
    ...args: Parameters<CoreService[C]>
  ): Promise<Awaited<ReturnType<CoreService[C]>>> {
    if (this.stopping !== null) return Promise.reject(new Error("内核正在关闭"));
    // 索引与参数共享同一 C；仅恢复 TypeScript 对异构方法索引丢失的对应关系。
    const invoke = this.service[command] as (
      ...input: Parameters<CoreService[C]>
    ) => ReturnType<CoreService[C]>;
    let result: Promise<Awaited<ReturnType<CoreService[C]>>>;
    try {
      result = Promise.resolve(invoke(...args));
    } catch (error) {
      return Promise.reject(error);
    }
    this.pending.add(result);
    void result.then(
      () => this.pending.delete(result),
      () => this.pending.delete(result),
    );
    return result;
  }

  /** 关闭原生入口，等待真实停机与所有 JS 结果交付；重复调用共用结果。 */
  shutdown(): Promise<void> {
    if (this.stopping !== null) return this.stopping;
    let native: Promise<void>;
    try {
      native = this.service.shutdown();
    } catch (error) {
      native = Promise.reject(error);
    }
    this.stopping = Promise.all([native, Promise.allSettled([...this.pending])]).then(
      () => undefined,
    );
    return this.stopping;
  }
}
