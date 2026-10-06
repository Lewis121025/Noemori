/** 配色协调界面框架与文档表面，与浅深色模式、字体和笔记内容分别保存。 */
export const READING_PALETTES = {
  monochrome: {
    id: "monochrome",
    label: "黑白",
    description: "黑白灰层级，清晰阅读",
  },
  green: {
    id: "green",
    label: "绿色",
    description: "森林绿框架、纸白与苔色",
  },
} as const;

/** 配色的稳定标识；跨进程和会话存储只接受当前提供的两种配色。 */
export type ReadingPalette = keyof typeof READING_PALETTES;

/** 首次使用、旧会话及损坏偏好采用黑白配色。 */
export const DEFAULT_READING_PALETTE: ReadingPalette = "monochrome";

/**
 * 校验外部配色标识，不抛出异常。
 * @param value 会话或 IPC 提供的未知输入。
 * @returns 当前支持的标识；其他值返回 null，由调用方回退或拒绝请求。
 */
export function parseReadingPalette(value: unknown): ReadingPalette | null {
  return value === "monochrome" || value === "green" ? value : null;
}
