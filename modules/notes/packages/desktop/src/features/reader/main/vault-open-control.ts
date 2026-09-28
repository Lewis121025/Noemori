import {
  VAULT_OPEN_PHASES,
  parseVaultOpenProgress,
  type VaultOpenProgress,
} from "../shared/vault-opening";

/** 主进程与同步内核线程之间共享开库状态；取消不排在阻塞调用后，缓冲区不暴露给渲染层。 */
export class VaultOpenControl {
  readonly buffer: SharedArrayBuffer;
  private readonly state: Int32Array;
  private lastProgress: VaultOpenProgress = { phase: "preparing", completed: 0, total: null };

  /** 未提供 buffer 时创建新请求；工作线程传入主进程创建的同一共享缓冲区。 */
  constructor(buffer?: SharedArrayBuffer) {
    this.buffer = buffer ?? new SharedArrayBuffer(5 * Int32Array.BYTES_PER_ELEMENT);
    this.state = new Int32Array(this.buffer);
    if (buffer === undefined) Atomics.store(this.state, 3, -1);
  }

  /** 请求取消准备；提交边界已经通过时返回 false，重复取消幂等。 */
  cancel(): boolean {
    return Atomics.compareExchange(this.state, 0, 0, 1) !== 2;
  }
  /** 工作线程在读取批次与事务边界检查取消。 */
  get cancelled(): boolean {
    return Atomics.load(this.state, 0) === 1;
  }

  /** 原子决定取消或提交谁先到达；返回 true 后提交不能被迟到取消反转。 */
  commit(): boolean {
    if (Atomics.compareExchange(this.state, 0, 0, 2) !== 0) return false;
    this.update({ phase: "committing", completed: 0, total: null });
    return true;
  }

  /** 执行线程发布同一版本的阶段与数量，不跨阶段拼接计数。 */
  update(progress: VaultOpenProgress): void {
    Atomics.add(this.state, 4, 1);
    Atomics.store(this.state, 1, VAULT_OPEN_PHASES.indexOf(progress.phase));
    Atomics.store(this.state, 2, progress.completed);
    Atomics.store(this.state, 3, progress.total ?? -1);
    Atomics.add(this.state, 4, 1);
  }

  /** 读取完整快照；发布期间重读，避免出现完成量超过总量的虚假进度。 */
  get progress(): VaultOpenProgress {
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = Atomics.load(this.state, 4);
      if (before % 2 !== 0) continue;
      const phase = VAULT_OPEN_PHASES[Atomics.load(this.state, 1)];
      const completed = Atomics.load(this.state, 2);
      const total = Atomics.load(this.state, 3);
      if (before === Atomics.load(this.state, 4)) {
        this.lastProgress = parseVaultOpenProgress({
          phase,
          completed,
          total: total < 0 ? null : total,
        });
        break;
      }
    }
    // 工作线程可能在发布中退出；主线程保留最后一份完整快照，不能原地忙等。
    return this.lastProgress;
  }
}
