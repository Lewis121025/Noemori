/**
 * 把笔记里的 HTML 源消毒成可挂到 NodeView 的 DOM。
 * 源码仍在 schema attr；只有预览走这里，避免把未过滤标签画进页面。
 */
import DOMPurify from "dompurify";

/**
 * 消毒 HTML 源，返回独立 fragment；调用方负责挂到预览容器。
 *
 * @param html 节点 attr 中的原文，可含未消毒标签。
 * @returns 已去掉 script / 事件处理器的 DocumentFragment。
 */
export function sanitizeHtml(html: string): DocumentFragment {
  const sanitized = DOMPurify.sanitize(html, { RETURN_DOM_FRAGMENT: true });
  if (sanitized instanceof DocumentFragment) {
    return sanitized;
  }
  return document.createDocumentFragment();
}
