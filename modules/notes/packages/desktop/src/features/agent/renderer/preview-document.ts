import DOMPurify from "dompurify";

/**
 * 将模型页面或图表包进无脚本、无外部资源的 iframe 文档。
 * @param text 待预览的 HTML 或 SVG，不得直接插入应用 DOM。
 * @returns 含限制性 CSP 的完整文档；调用方必须同时设置空 sandbox 属性。
 * @throws DOM 解析不可用时抛出原始异常。
 */
export function previewDocument(text: string): string {
  const clean = DOMPurify.sanitize(text, {
    WHOLE_DOCUMENT: true,
    ADD_TAGS: ["style", "foreignObject"],
    // Mermaid 用 foreignObject 承载 HTML 文字；显式开放命名空间交界，内容仍逐节点清理。
    HTML_INTEGRATION_POINTS: { foreignobject: true },
    FORBID_TAGS: ["script", "iframe", "object", "embed", "link", "base", "meta", "form"],
    FORBID_ATTR: ["srcdoc", "action", "formaction"],
  });
  const page = new DOMParser().parseFromString(clean, "text/html");
  page.querySelectorAll("a").forEach((link) => {
    link.removeAttribute("href");
    link.removeAttribute("xlink:href");
  });
  const policy = page.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  policy.content =
    "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; form-action 'none'; base-uri 'none'";
  page.head.prepend(policy);
  return "<!doctype html>" + page.documentElement.outerHTML;
}
