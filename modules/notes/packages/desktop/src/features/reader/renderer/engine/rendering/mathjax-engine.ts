/**
 * MathJax 4 引擎本体。必须被动态 import：本文件的静态依赖会拉进排版器与字形表。
 *
 * 不加载 ui/menu、a11y/speech：朗读走 Web Worker，和 CSP 冲突，也与「打开后零排版」无关。
 */
import { MathJaxNewcmFont } from "@mathjax/mathjax-newcm-font/js/chtml.js";
import { browserAdaptor } from "@mathjax/src/js/adaptors/browserAdaptor.js";
import { RegisterHTMLHandler } from "@mathjax/src/js/handlers/html.js";
import { TeX } from "@mathjax/src/js/input/tex.js";
import "@mathjax/src/js/input/tex/ams/AmsConfiguration.js";
import "@mathjax/src/js/input/tex/newcommand/NewcommandConfiguration.js";
import "@mathjax/src/js/input/tex/noundefined/NoUndefinedConfiguration.js";
import "@mathjax/src/js/input/tex/textmacros/TextMacrosConfiguration.js";
import { mathjax } from "@mathjax/src/js/mathjax.js";
import { CHTML } from "@mathjax/src/js/output/chtml.js";

const dynamicGlyphs = import.meta.glob(
  "../../../../../../node_modules/@mathjax/mathjax-newcm-font/mjs/chtml/dynamic/*.js",
);

const glyphLoaders = new Map<string, () => Promise<unknown>>();
for (const [path, loader] of Object.entries(dynamicGlyphs)) {
  glyphLoaders.set(path.slice(path.lastIndexOf("/") + 1), loader);
}

/** 进程内复用的公式排版器；动态样式与页面同寿命，不归单篇笔记所有。 */
export type MathJaxEngine = {
  /** 把 TeX 排成 CHTML 节点；非法 TeX 走 merror，不抛。 */
  convert: (tex: string, display: boolean) => Promise<HTMLElement>;
};

function fontUrl(): string {
  return new URL("mathjax-fonts/woff2", document.baseURI).href.replace(/\/+$/, "");
}

function installAsyncLoad(): void {
  mathjax.asyncLoad = async (name: string) => {
    const file = name.replace(/^.*\//, "").replace(/(\.js)?$/, ".js");
    const loader = glyphLoaders.get(file);
    if (loader === undefined) {
      throw new Error(`缺少 MathJax 动态字形: ${name}`);
    }
    const mod: unknown = await loader();
    if (typeof mod === "object" && mod !== null && "default" in mod) {
      return mod.default;
    }
    return mod;
  };
}

function asHtml(value: unknown, what: string): HTMLElement {
  if (value instanceof HTMLElement) {
    return value;
  }
  throw new Error(`MathJax ${what} 未返回 HTML 节点`);
}

/**
 * 在浏览器 DOM 上创建一份 CHTML 引擎。
 *
 * @returns 可供 warmup / NodeView 复用的引擎；进程内只应创建一次。
 */
export function createMathJaxEngine(): MathJaxEngine {
  installAsyncLoad();
  const adaptor = browserAdaptor();
  RegisterHTMLHandler(adaptor);
  const tex = new TeX({
    packages: ["base", "ams", "newcommand", "noundefined", "textmacros"],
  });
  const chtml = new CHTML({
    fontData: MathJaxNewcmFont,
    fontURL: fontUrl(),
    dynamicPrefix: "@mathjax/mathjax-newcm-font/js/chtml/dynamic",
    adaptiveCSS: true,
  });
  const html = mathjax.document(document, {
    InputJax: tex,
    OutputJax: chtml,
  });
  // 动态规则通过 CSSOM 追加；移动 style 或让 ProseMirror 重建它会丢失规则。
  // 首次排版前固定到 head，后续公式只追加样式，切换笔记与命中缓存都能复用。
  document.head.append(asHtml(chtml.styleSheet(html), "stylesheet"));
  return {
    async convert(source: string, display: boolean): Promise<HTMLElement> {
      const node = await html.convertPromise(source, { display, em: 16, ex: 8 });
      chtml.styleSheet(html);
      return asHtml(node, "convert");
    },
  };
}
