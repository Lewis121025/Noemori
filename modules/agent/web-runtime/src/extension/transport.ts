import { record } from "../browser/contract.js";

/** 单个已授权标签页或其子 frame 的实际 debugger 会话。 */
export type CdpSession = chrome.debugger.Debuggee & { sessionId?: string };
/** 薄 CDP 传输接口；只封装 extension API，不伪造浏览器端点。 */
export interface CdpTransport {
  attach(tab: number): Promise<void>;
  detach(tab: number): Promise<void>;
  send(session: CdpSession, method: string, values?: Record<string, unknown>): Promise<unknown>;
}
/** 当前操作的取消与副作用事实；已发出的协议命令无法当作未执行。 */
export class Operation {
  dispatched = false;
  /** 绑定当前 RPC 的信号和截止时间，不创建全局后台输入。 */
  constructor(
    readonly signal: AbortSignal,
    private readonly deadline: number,
  ) {}
  /** 检查取消、时间和当前控制权；失败时停止后续输入。 */
  check(): void {
    if (this.signal.aborted) throw new Error("浏览器操作已取消");
    if (performance.now() >= this.deadline) throw new Error("浏览器操作超过当前预算");
  }
  /** 在真正发送修改命令前登记派发阶段。 */
  dispatch(): void {
    this.check();
    this.dispatched = true;
  }
  /** 将扩展协议等待限制在同一 RPC 的剩余预算内，不创建跨调用后台任务。 */
  budget(): number { this.check(); return Math.max(1, this.deadline - performance.now()); }
  /** 有界等待观察轮询；取消不能触发后续动作。 */
  async pause(): Promise<void> {
    this.check();
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    this.check();
  }
}

/** 将 CDP Runtime 结果解码成经过检查的 JSON；页面异常不能被冒充为观察成功。 */
export function runtimeValue(value: unknown): unknown {
  const response = record(value);
  if (response.exceptionDetails) {
    const details = record(response.exceptionDetails);
    const exception = details.exception ? record(details.exception) : {};
    throw new Error(
      typeof exception.description === "string" ? exception.description : "页面执行异常",
    );
  }
  return record(response.result).value;
}
/** 对原始 Chrome debugger 只做参数和取消检查；普通 JS 无法调用此传输。 */
export const chromeTransport: CdpTransport = {
  attach: (tabId) => chrome.debugger.attach({ tabId }, "1.3"),
  detach: (tabId) => chrome.debugger.detach({ tabId }),
  send: (session, method, values = {}) => chrome.debugger.sendCommand(session, method, values),
};
