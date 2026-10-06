/**
 * Obsidian 方言的行内语法：`==高亮==` 与 `%%注释%%`。
 *
 * 在词法阶段识别，与 GFM 删除线同一套 attention 规则（左右侧字符分类决定能否
 * 开合），因此转义、代码与嵌套格式的处理与其他语法一致。序列化时把连续的
 * `==`、`%%` 转义成 `\=`、`\%`，普通文本不会在重新解析时被误读成语法。
 *
 * 已知边界：注释只在单个段落内识别；跨空行的块注释按普通文本保留。
 */
import type { Extension as FromMarkdownExtension } from "mdast-util-from-markdown";
import type { Options as ToMarkdownExtension } from "remark-stringify";
import type {
  Code,
  Event,
  Extension,
  Resolver,
  State,
  Token,
  TokenizeContext,
  Tokenizer,
} from "micromark-util-types";
import type { Literal, Parent, PhrasingContent } from "mdast";
import type { Plugin } from "unified";
import { splice } from "micromark-util-chunked";
import { classifyCharacter } from "micromark-util-classify-character";
import { resolveAll } from "micromark-util-resolve-all";

/** `==高亮==`；子节点是普通行内内容。 */
interface Highlight extends Parent {
  type: "highlight";
  children: PhrasingContent[];
}

/** `%%注释%%`；`value` 是两组 `%%` 之间的原文。 */
interface Comment extends Literal {
  type: "comment";
}

declare module "mdast" {
  interface RootContentMap {
    highlight: Highlight;
    comment: Comment;
  }
  interface PhrasingContentMap {
    highlight: Highlight;
    comment: Comment;
  }
}

declare module "micromark-util-types" {
  interface TokenTypeMap {
    highlight: "highlight";
    highlightSequence: "highlightSequence";
    highlightSequenceTemporary: "highlightSequenceTemporary";
    highlightText: "highlightText";
    comment: "comment";
    commentData: "commentData";
  }
}

const EQUALS = 61;
const PERCENT = 37;
/** micromark 的字符分类：标点。 */
const PUNCTUATION = 2;

function isLineEnding(code: Code): boolean {
  return code !== null && code < -2;
}

/** 与 GFM 删除线相同的开合解析，只接受恰好两个 `=`。 */
const resolveAllHighlight: Resolver = (events, context) => {
  let index = -1;
  while (++index < events.length) {
    const closer = events[index];
    if (
      closer === undefined ||
      closer[0] !== "enter" ||
      closer[1].type !== "highlightSequenceTemporary" ||
      closer[1]._close !== true
    )
      continue;
    let open = index;
    while (open--) {
      const opener = events[open];
      if (
        opener === undefined ||
        opener[0] !== "exit" ||
        opener[1].type !== "highlightSequenceTemporary" ||
        opener[1]._open !== true
      )
        continue;
      closer[1].type = "highlightSequence";
      opener[1].type = "highlightSequence";
      const highlight: Token = {
        type: "highlight",
        start: { ...opener[1].start },
        end: { ...closer[1].end },
      };
      const text: Token = {
        type: "highlightText",
        start: { ...opener[1].end },
        end: { ...closer[1].start },
      };
      const next: Event[] = [
        ["enter", highlight, context],
        ["enter", opener[1], context],
        ["exit", opener[1], context],
        ["enter", text, context],
      ];
      const insideSpan = context.parser.constructs.insideSpan.null;
      if (insideSpan)
        splice(
          next,
          next.length,
          0,
          resolveAll(insideSpan, events.slice(open + 1, index), context),
        );
      splice(next, next.length, 0, [
        ["exit", text, context],
        ["enter", closer[1], context],
        ["exit", closer[1], context],
        ["exit", highlight, context],
      ]);
      splice(events, open - 1, index - open + 3, next);
      index = open + next.length - 2;
      break;
    }
  }
  for (const event of events) {
    if (event[1].type === "highlightSequenceTemporary") event[1].type = "data";
  }
  return events;
};

const tokenizeHighlight: Tokenizer = function (this: TokenizeContext, effects, ok, nok) {
  const previous = this.previous;
  const events = this.events;
  let size = 0;
  return start;

  function start(code: Code): State | undefined {
    // 被转义的 `=` 之后可以开新序列，其他情况下 `=` 连续出现属于同一序列。
    if (previous === EQUALS && events[events.length - 1]?.[1].type !== "characterEscape")
      return nok(code);
    effects.enter("highlightSequenceTemporary");
    return more(code);
  }

  function more(code: Code): State | undefined {
    const before = classifyCharacter(previous);
    if (code === EQUALS) {
      if (size > 1) return nok(code);
      effects.consume(code);
      size += 1;
      return more;
    }
    if (size < 2) return nok(code);
    const token = effects.exit("highlightSequenceTemporary");
    const after = classifyCharacter(code);
    token._open = !after || (after === PUNCTUATION && Boolean(before));
    token._close = !before || (before === PUNCTUATION && Boolean(after));
    return ok(code);
  }
};

const tokenizeComment: Tokenizer = function (effects, ok, nok) {
  let opened = 0;
  // 行尾之间的字符必须落在打开的子 token 里，micromark 不允许退出行尾后直接续写父 token。
  let data = false;
  return start;

  function start(code: Code): State | undefined {
    effects.enter("comment");
    return open(code);
  }

  function open(code: Code): State | undefined {
    if (code === PERCENT && opened < 2) {
      effects.consume(code);
      opened += 1;
      return open;
    }
    return opened < 2 ? nok(code) : inside(code);
  }

  function inside(code: Code): State | undefined {
    if (code === null) return nok(code);
    if (isLineEnding(code)) {
      if (data) effects.exit("commentData");
      data = false;
      effects.enter("lineEnding");
      effects.consume(code);
      effects.exit("lineEnding");
      return inside;
    }
    if (!data) effects.enter("commentData");
    data = true;
    effects.consume(code);
    return code === PERCENT ? maybeClose : inside;
  }

  function maybeClose(code: Code): State | undefined {
    if (code !== PERCENT) return inside(code);
    effects.consume(code);
    effects.exit("commentData");
    effects.exit("comment");
    return ok;
  }
};

const highlightConstruct = {
  name: "highlight",
  tokenize: tokenizeHighlight,
  resolveAll: resolveAllHighlight,
};

const syntax: Extension = {
  text: { [EQUALS]: highlightConstruct, [PERCENT]: { name: "comment", tokenize: tokenizeComment } },
  insideSpan: { null: [highlightConstruct] },
  attentionMarkers: { null: [EQUALS] },
};

const fromMarkdown: FromMarkdownExtension = {
  canContainEols: ["highlight"],
  enter: {
    highlight(token) {
      this.enter({ type: "highlight", children: [] }, token);
    },
    comment(token) {
      this.enter({ type: "comment", value: "" }, token);
    },
  },
  exit: {
    highlight(token) {
      this.exit(token);
    },
    comment(token) {
      const node = this.stack[this.stack.length - 1];
      if (node?.type === "comment") node.value = this.sliceSerialize(token).slice(2, -2);
      this.exit(token);
    },
  },
};

const toMarkdown: ToMarkdownExtension = {
  handlers: {
    highlight(node: Highlight, _parent, state, info) {
      const inner = state.containerPhrasing(node, { ...info, before: "=", after: "=" });
      // 紧贴空白的 `==` 不能开合；首尾空白移到分隔符外，重新解析仍得到同一段高亮。
      const lead = /^\s*/.exec(inner)?.[0] ?? "";
      const core = inner.slice(lead.length).trimEnd();
      if (core === "") return inner;
      return `${lead}==${core}==${inner.slice(lead.length + core.length)}`;
    },
    comment(node: Comment) {
      return `%%${node.value}%%`;
    },
  },
  unsafe: [
    { character: "=", after: "=", inConstruct: "phrasing" },
    { character: "%", after: "%", inConstruct: "phrasing" },
  ],
};

/** 向 remark 注册高亮与注释的词法、语法树与序列化扩展。 */
export const remarkObsidian: Plugin = function () {
  const data = this.data();
  (data.micromarkExtensions ??= []).push(syntax);
  (data.fromMarkdownExtensions ??= []).push(fromMarkdown);
  (data.toMarkdownExtensions ??= []).push(toMarkdown);
};
