/**
 * 应用会话：窗口、外观及各功能独立的恢复状态。
 *
 * 只在内核工作线程读写；渲染进程不能提交任意库路径。损坏或缺失的文件视为空会话。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseAppearance, type Appearance } from "../shared/api";
import {
  emptyReaderSession,
  parseReaderSession,
  type ReaderSession,
} from "../features/reader/shared/session";

/** 窗口位置与最大化；最大化时 x/y/宽高是还原后的 normal bounds。 */
export type WindowSession = {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
};

/** 启动时恢复的会话；旧的分栏和钉住字段读取时忽略，不影响笔记库与文档。 */
export type Session = {
  /** 独立于笔记库的应用外观偏好；旧会话默认跟随系统。 */
  appearance: Appearance;
  /** 各功能独立持有恢复状态，应用会话只负责组合。 */
  reader: ReaderSession;
  /** 上次窗口几何。 */
  window: WindowSession | null;
};

/** 没有任何记忆时显示文件栏，辅助内容由用户按需展开。 */
export const emptySession: Session = {
  appearance: "system",
  reader: emptyReaderSession,
  window: null,
};

/**
 * 会话文件路径。放在 userData 根下，不进笔记库。
 *
 * @param userData Electron `app.getPath("userData")`。
 * @returns 会话文件的绝对路径；本函数不访问磁盘。
 */
export function sessionFile(userData: string): string {
  return join(userData, "session.json");
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseWindow(value: unknown): WindowSession | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  if (!("x" in value) || !("y" in value) || !("width" in value) || !("height" in value)) {
    return null;
  }
  if (
    !isFiniteNumber(value.x) ||
    !isFiniteNumber(value.y) ||
    !isFiniteNumber(value.width) ||
    !isFiniteNumber(value.height)
  ) {
    return null;
  }
  return {
    x: value.x,
    y: value.y,
    width: value.width,
    height: value.height,
    maximized: "maximized" in value && value.maximized === true,
  };
}

/**
 * 把 JSON 文本解析为会话；无法识别则返回 `null`。
 *
 * @param raw UTF-8 JSON。
 * @returns 归一化后的会话；语法无效或根值不是对象时返回 null。
 */
export function parseSession(raw: string): Session | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return null;
  }
  const record = data as Record<string, unknown>;
  return {
    // 兼容旧版平铺状态；新写入只保留 reader 命名空间。
    reader: parseReaderSession("reader" in record ? record.reader : record),
    appearance: parseAppearance(record.appearance) ?? "system",
    window: "window" in record ? parseWindow(record.window) : null,
  };
}

/**
 * 把会话写成确定性 JSON。
 *
 * @param session 当前会话。
 * @returns 带末尾换行的 JSON 文本。
 */
export function serializeSession(session: Session): string {
  return `${JSON.stringify(session, null, 2)}\n`;
}

/**
 * 从磁盘读取会话；文件不存在或损坏时返回空会话。
 *
 * @param file 会话文件绝对路径。
 * @returns 可用会话；文件缺失、不可读或损坏时返回空会话。
 */
export function loadSession(file: string): Session {
  try {
    return parseSession(readFileSync(file, "utf8")) ?? emptySession;
  } catch {
    return emptySession;
  }
}

/**
 * 覆盖写入会话。
 *
 * @param file 会话文件绝对路径。
 * @param session 要保存的完整会话。
 * @throws 创建目录或写入文件失败时，保留底层文件系统错误。
 */
export function saveSession(file: string, session: Session): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, serializeSession(session));
}

/**
 * 合并补丁后写回。
 *
 * @param file 会话文件绝对路径。
 * @param patch 要覆盖的字段。
 * @returns 写盘后的完整会话。
 * @throws 合并后的会话无法写入时，保留底层文件系统错误。
 */
export function patchSession(file: string, patch: Partial<Session>): Session {
  const next = { ...loadSession(file), ...patch };
  saveSession(file, next);
  return next;
}
