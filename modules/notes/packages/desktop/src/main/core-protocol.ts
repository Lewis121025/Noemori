import type { CoreService } from "./core-service";
import type { VaultEvent } from "../features/reader/shared/api";

/** 只允许主进程提交已知内核命令。 */
export type CoreCommand = keyof CoreService;

/** 带请求编号的线程消息；参数类型由命令签名约束。 */
export type CoreRequest<C extends CoreCommand = CoreCommand> = {
  [K in C]: {
    type: "call";
    id: number;
    command: K;
    args: Parameters<CoreService[K]>;
  };
}[C];

/** 停机消息排在已有命令之后，禁止强行中断正在写盘的线程。 */
export type CoreInput = CoreRequest | { type: "shutdown" };

/** 私有线程通道上的结果或监视事件，错误消息保留内核给出的路径与原因。 */
export type CoreOutput =
  | { type: "result"; id: number; value: unknown }
  | { type: "error"; id: number; message: string }
  | { type: "changed"; event: VaultEvent }
  | { type: "stopped" };
