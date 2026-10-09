import type { TextColor, HighlightColor } from "./text-style";

/**
 * Word 每段文字只有一个字符样式；颜色、高亮与代码字体必须合成同一个样式名。
 * @param text 文字颜色；null 表示沿用默认颜色。
 * @param highlight 高亮背景色；null 表示没有高亮。
 * @param code 是否同时继承代码字体。
 * @returns 与构建期 reference.docx 对应的稳定名称；无配色时返回 null，不抛出异常。
 */
export function wordTextStyle(
  text: TextColor | null,
  highlight: HighlightColor | null,
  code: boolean,
): string | null {
  if (text === null && highlight === null) return null;
  if (text === null && highlight === "yellow" && !code) return "NoemoriHighlight";
  return `NoemoriText_${text ?? "default"}_${highlight ?? "none"}${code ? "_code" : ""}`;
}
