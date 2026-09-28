/** wiki 在词法阶段识别，沿用 Markdown 对转义、代码及嵌套格式的处理。 */
import type { Extension as MdastExtension } from "mdast-util-from-markdown";
import type { Extension, Tokenizer } from "micromark-util-types";
import type { Plugin } from "unified";
import type { Literal } from "mdast";

/** 保留 wiki 原始拼写，映射文档节点时再解码目标和别名。 */
export type WikiLink = Literal & { type: "wikiLink"; value: string };

declare module "mdast" {
  interface RootContentMap {
    wikiLink: WikiLink;
  }
  interface PhrasingContentMap {
    wikiLink: WikiLink;
  }
}

declare module "micromark-util-types" {
  interface TokenTypeMap {
    wikiLink: "wikiLink";
  }
}

const tokenize: Tokenizer = function (effects, ok, nok) {
  let length = 0;
  return start;

  function start(code: number | null) {
    effects.enter("wikiLink");
    if (code === 33) {
      effects.consume(code);
      return firstBracket;
    }
    return firstBracket(code);
  }

  function firstBracket(code: number | null) {
    if (code !== 91) return nok(code);
    effects.consume(code);
    return secondBracket;
  }

  function secondBracket(code: number | null) {
    if (code !== 91) return nok(code);
    effects.consume(code);
    return content;
  }

  function content(code: number | null) {
    if (code === null || code < 0 || code === 91) return nok(code);
    if (code === 93) {
      if (length === 0) return nok(code);
      effects.consume(code);
      return closingBracket;
    }
    length += 1;
    effects.consume(code);
    return content;
  }

  function closingBracket(code: number | null) {
    if (code !== 93) return nok(code);
    effects.consume(code);
    effects.exit("wikiLink");
    return ok;
  }
};

const syntax: Extension = { text: { 33: { tokenize }, 91: { tokenize } } };
const ast: MdastExtension = {
  enter: {
    wikiLink(token) {
      this.enter({ type: "wikiLink", value: "" }, token);
    },
  },
  exit: {
    wikiLink(token) {
      const node = this.stack[this.stack.length - 1];
      if (node?.type === "wikiLink") node.value = this.sliceSerialize(token);
      this.exit(token);
    },
  },
};

/** 向 remark 注册 wiki 词法与语法树扩展，不改写普通文本节点。 */
export const remarkWiki: Plugin = function () {
  const data = this.data();
  (data.micromarkExtensions ??= []).push(syntax);
  (data.fromMarkdownExtensions ??= []).push(ast);
};
