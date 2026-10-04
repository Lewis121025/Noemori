/** 阅读器的精选字体搭配；稳定标识用于应用偏好，字体资源由宿主离线提供。 */
export const READING_FONTS = {
  lora: {
    id: "lora",
    label: "温润书页",
    description: "Lora · Noto 宋体",
    family: '"Lora Variable", "Noto Serif SC Variable", serif',
  },
  newsreader: {
    id: "newsreader",
    label: "轻盈杂志",
    description: "Newsreader · Noto 宋体",
    family: '"Newsreader Variable", "Noto Serif SC Variable", serif',
  },
  sans: {
    id: "sans",
    label: "清晰现代",
    description: "Inter · Noto 黑体",
    family: '"Inter Variable", "Noto Sans SC Variable", sans-serif',
  },
} as const;

/** 阅读字体只影响排版，不写入笔记或覆盖代码、公式的专用字体。 */
export type ReadingFont = keyof typeof READING_FONTS;

/** 首次使用及旧会话采用用户选定的 Lora 书页搭配。 */
export const DEFAULT_READING_FONT: ReadingFont = "lora";

/**
 * 校验持久化与 IPC 输入，不抛出异常。
 * @param value 外部输入的字体标识。
 * @returns 已登记的标识；未知值返回 null，由调用方决定回退或拒绝。
 */
export function parseReadingFont(value: unknown): ReadingFont | null {
  return value === "lora" || value === "newsreader" || value === "sans" ? value : null;
}
