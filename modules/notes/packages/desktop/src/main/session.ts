/**
 * 应用会话：窗口、外观及各功能独立的恢复状态。
 *
 * 这里只定义宿主协议；会话磁盘读写与迁移由 Rust 运行时负责。
 */
import { parseAppearance, type Appearance } from "../shared/api";
import {
  DEFAULT_READING_FONT,
  parseReadingFont,
  type ReadingFont,
} from "../features/reader/shared/reading-font";
import {
  DEFAULT_READING_PALETTE,
  parseReadingPalette,
  type ReadingPalette,
} from "../features/reader/shared/reading-palette";
import { parseReaderSession, type ReaderSession } from "../features/reader/shared/session";

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
  /** 独立于笔记库的阅读字体搭配。 */
  readingFont: ReadingFont;
  /** 独立于字体与浅深色模式的阅读配色，旧会话默认黑白。 */
  readingPalette: ReadingPalette;
  /** 各功能独立持有恢复状态，应用会话只负责组合。 */
  reader: ReaderSession;
  /** 上次窗口几何。 */
  window: WindowSession | null;
};

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
    readingFont: parseReadingFont(record.readingFont) ?? DEFAULT_READING_FONT,
    readingPalette: parseReadingPalette(record.readingPalette) ?? DEFAULT_READING_PALETTE,
    window: "window" in record ? parseWindow(record.window) : null,
  };
}
