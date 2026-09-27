/** 应用桥接协议；外壳能力与阅读器能力分别暴露。 */
import type {
  HistoryAction,
  HistoryAvailability,
  ReaderApi,
  ReaderCommand,
} from "../features/reader/shared/api";
import { parseReaderCommand } from "../features/reader/shared/commands";

/** 应用外观；system 随操作系统切换，显式选择同时作用于窗口与正文。 */
export type Appearance = "system" | "light" | "dark";

/** 原生菜单只传递已声明的用户动作，由当前输入表面或工作区处理。 */
export type AppCommand = ReaderCommand | HistoryAction;

/** 校验跨进程历史投影；缺失或非布尔字段返回 null，不影响现有菜单。 */
export function parseHistoryAvailability(value: unknown): HistoryAvailability | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("undo" in value) ||
    !("redo" in value) ||
    typeof value.undo !== "boolean" ||
    typeof value.redo !== "boolean"
  )
    return null;
  return { undo: value.undo, redo: value.redo };
}

/** 校验菜单事件，拒绝未注册的动作。 */
export function parseAppCommand(value: unknown): AppCommand | null {
  return value === "undo" || value === "redo" ? value : parseReaderCommand(value);
}

/** 校验外观输入；未知值返回 null，由会话读取与 IPC 分别决定回退或拒绝。 */
export function parseAppearance(value: unknown): Appearance | null {
  return value === "system" || value === "light" || value === "dark" ? value : null;
}

/** 应用外壳能力，不包含文件、索引或编辑器操作。 */
export type AppApi = {
  /** 顺序发送当前输入表面的历史投影；不持久化，窗口关闭或重载时失效。 */
  historyChanged: (availability: HistoryAvailability) => void;
  /** 订阅原生菜单操作，卸载时取消订阅。 */
  subscribeCommand: (callback: (command: AppCommand) => void) => () => void;
  /** 读取当前应用外观偏好。 */
  appearanceGet: () => Promise<Appearance>;
  /** 保存并应用外观偏好；持久化失败时保留原外观并拒绝请求。 */
  appearanceSet: (appearance: Appearance) => Promise<void>;
  /**
   * 关窗口前主进程会发冲刷请求；渲染进程应先保存再决定是否放行。
   *
   * @returns 取消订阅。
   */
  subscribeFlushBeforeClose: (callback: () => void) => () => void;
  /** 冲刷成功后允许窗口关闭。 */
  closeAfterFlush: () => Promise<void>;
  /** 冲刷失败，取消这次退出意图，窗口留着。 */
  closeBlocked: () => Promise<void>;
};

/** preload 只负责组合各模块的公开能力，不提供任意 IPC 入口。 */
export type NousApi = {
  app: AppApi;
  reader: ReaderApi;
};
