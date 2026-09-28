import type { EntryBatchProgress } from "../shared/entry-batch";

/**
 * 主进程与同步内核线程共享的批次状态；缓冲区不暴露给渲染进程。
 * 主进程初始化范围并写入停止位；执行线程核定总数并发布完成量，原子读写不依赖消息队列。
 */
export class EntryBatchControl {
  private readonly state: Int32Array;

  /** 新批次创建独立缓冲区；工作线程传入结构化克隆后的同一共享缓冲区。 */
  constructor(
    readonly buffer: SharedArrayBuffer = new SharedArrayBuffer(4 * Int32Array.BYTES_PER_ELEMENT),
  ) {
    this.state = new Int32Array(buffer);
  }

  /** 请求在当前条目提交后停止，不中断文件事务。 */
  stop(): void {
    Atomics.store(this.state, 0, 1);
  }

  /** 执行线程在预检前和每项开始前读取，停止请求不会因事件队列阻塞而丢失。 */
  get stopped(): boolean {
    return Atomics.load(this.state, 0) !== 0;
  }

  /** 设置请求范围，执行前再扣除跳过项；每个缓冲区只用于一轮提交。 */
  start(total: number): void {
    Atomics.store(this.state, 1, total);
  }

  /** 全量预检通过后才进入执行阶段。 */
  running(): void {
    Atomics.store(this.state, 3, 1);
  }

  /** 只发布已完整提交的数量，失败的当前项仍属于剩余项。 */
  completed(count: number): void {
    Atomics.store(this.state, 2, count);
  }

  /** 总量在执行前固定；先读已完成数，避免把下一项误报为已完成。 */
  get progress(): EntryBatchProgress {
    const completed = Atomics.load(this.state, 2);
    return {
      phase: Atomics.load(this.state, 3) === 0 ? "checking" : "running",
      completed,
      total: Atomics.load(this.state, 1),
    };
  }
}
