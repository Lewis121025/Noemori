import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { trimText, type ReadResult } from "./contract.js";
import { challengeSignals, classifyChallenge, challengeReason } from "./challenge.js";

/**
 * 从已有 DOM 快照提取正文；不执行输入脚本，保留代码块和表格结构。
 * @param html 浏览器已完成读取的 HTML。
 * @param url 最终页面 URL，用于解析正文里的相对链接。
 * @param maxChars 正文 Unicode 字符上限。
 * @returns 带来源与明确截断标记的可读正文。
 * @throws 页面没有可提取正文时返回具体错误。
 */
export function extractHtml(html: string, url: string, maxChars: number): ReadResult {
  const dom = new JSDOM(html, { url });
  try {
    const document = dom.window.document;
    const challenge = classifyChallenge(challengeSignals(document));
    if (challenge.kind !== "none") throw new Error(challengeReason(challenge));
    const main = document.querySelector("main, article, [role=main]");
    let title = document.title.trim();
    let content: string;
    if (main && main.textContent?.trim()) {
      for (const node of main.querySelectorAll(
        "nav, aside, footer, script, style, [hidden], [aria-hidden=true]",
      ))
        node.remove();
      for (const link of main.querySelectorAll<HTMLAnchorElement>("a[href]"))
        link.setAttribute("href", link.href);
      content = main.innerHTML;
    } else {
      const article = new Readability(document, { charThreshold: 100 }).parse();
      if (!article?.textContent?.trim())
        throw new Error("网页没有可提取正文，可能需要登录或尚未加载完成");
      title = article.title || title;
      content = article.content || "";
    }
    const markdown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
    markdown.use(gfm);
    markdown.remove(["script", "style", "nav", "aside", "footer"]);
    const text = markdown.turndown(content).trim();
    if (!text) throw new Error("网页正文提取后为空");
    return {
      ...(title ? { title } : {}),
      url,
      ...trimText(text, maxChars),
      warnings: [],
      images: [],
    };
  } finally {
    dom.window.close();
  }
}
