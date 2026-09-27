/**
 * 搜索查询文本解析与摘要切分。
 *
 * 语法（Obsidian 风格，与内核 `SearchExpr` 一一对应）：
 *
 * - 空白分隔的条件是 AND；大写 `OR` 连接备选；括号分组；`-` 前缀取反；
 * - 双引号包裹的是字面全文词，引号内 `""` 表示字面引号，引号内不解析谓词；
 * - `/正则/`；`tag:名称` 或 `#名称`；`path:子串`；`file:名称`；
 * - `[键]` 要求属性存在，`[键:值]` 要求属性等值；`键:值` 等同 `[键:值]`，但键不含 `/`
 *   且值不以 `/` 开头，`https://example.com` 这类 URL 保持字面；
 * - `line:( … )`、`section:( … )` 要求条件落在同一行或同一标题段；也可只跟一个词。
 *
 * 解析是全函数：括号不配对、孤立运算符都按字面或忽略降级，不抛错。
 * 大小写与 `#` 前缀的规范化由内核统一执行，这里保留用户原文。
 */

import type { SearchExpr, SearchHit, SearchQuery } from "../../../shared/api";

/** 结果上限；与内核默认一致，界面不提供调项。 */
export const SEARCH_LIMIT = 100;

/** 摘要片段；`mark` 为 true 时是命中词，界面渲染为高亮。 */
export type SnippetPart = { text: string; mark: boolean };

type Token =
  | { type: "open" | "close" | "or" | "not" }
  | { type: "scope"; kind: "line" | "section" }
  | { type: "regex"; source: string }
  | { type: "bracket"; content: string }
  /** `quoteStart` 是首个引号内字符在 `text` 中的下标；没有引号为 -1。 */
  | { type: "word"; text: string; quoteStart: number };

const EMPTY: SearchExpr = { kind: "and", children: [] };

/**
 * 把查询文本解析为检索表达式。
 *
 * @param text 搜索框原文，允许为空。
 * @returns 检索条件；空文本得到空表达式（调用方据 `isEmptyQuery` 退出结果模式）。
 */
export function parseSearchQuery(text: string): SearchQuery {
  const parser = new Parser(tokenize(text));
  return { expr: parser.parse(), limit: SEARCH_LIMIT };
}

/** 条件是否为空：没有任何条件时不应发起检索。 */
export function isEmptyQuery(query: SearchQuery): boolean {
  return query.expr.kind === "and" && query.expr.children.length === 0;
}

function isSpace(ch: string): boolean {
  return /\s/.test(ch);
}

/** 词法切分：括号、`OR`、取反、作用域前缀、正则、方括号属性与普通词。 */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < text.length) {
    const ch = text[index] as string;
    if (isSpace(ch)) {
      index += 1;
      continue;
    }
    if (ch === "(" || ch === ")") {
      tokens.push({ type: ch === "(" ? "open" : "close" });
      index += 1;
      continue;
    }
    const next = text[index + 1];
    if (ch === "-" && next !== undefined && !isSpace(next) && next !== ")") {
      tokens.push({ type: "not" });
      index += 1;
      continue;
    }
    if (ch === "/") {
      const end = closingSlash(text, index + 1);
      if (end > index + 1) {
        tokens.push({ type: "regex", source: text.slice(index + 1, end).replace(/\\\//g, "/") });
        index = end + 1;
        continue;
      }
    }
    if (ch === "[" && next !== "[") {
      const end = text.indexOf("]", index + 1);
      if (end > index + 1) {
        tokens.push({ type: "bracket", content: text.slice(index + 1, end) });
        index = end + 1;
        continue;
      }
    }
    index = readWord(text, index, tokens);
  }
  return tokens;
}

/** 正则的结束斜杠（跳过转义）；没有闭合时返回 -1，按普通词处理。 */
function closingSlash(text: string, from: number): number {
  for (let index = from; index < text.length; index += 1) {
    if (text[index] === "\\") index += 1;
    else if (text[index] === "/") return index;
  }
  return -1;
}

/** 读一个普通词；`line:`/`section:` 紧跟 `(` 时产出作用域前缀。@returns 词之后的下标。 */
function readWord(text: string, start: number, tokens: Token[]): number {
  let word = "";
  let quoteStart = -1;
  let index = start;
  while (index < text.length) {
    const ch = text[index] as string;
    if (ch === '"') {
      if (quoteStart < 0) quoteStart = word.length;
      index += 1;
      while (index < text.length) {
        if (text[index] === '"') {
          if (text[index + 1] === '"') {
            word += '"';
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        word += text[index];
        index += 1;
      }
      continue;
    }
    if (isSpace(ch) || ch === ")") break;
    if (ch === "(") {
      const scope = quoteStart < 0 ? /^(line|section):$/.exec(word)?.[1] : undefined;
      if (scope === "line" || scope === "section") {
        tokens.push({ type: "scope", kind: scope });
        return index;
      }
      break;
    }
    word += ch;
    index += 1;
  }
  if (word === "OR" && quoteStart < 0) tokens.push({ type: "or" });
  else if (word !== "" || quoteStart >= 0) tokens.push({ type: "word", text: word, quoteStart });
  return index;
}

/** 递归下降：OR 优先级最低，其次是空白连接的 AND，取反与分组最高。 */
class Parser {
  private index = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): SearchExpr {
    const parts: SearchExpr[] = [];
    // 顶层多余的右括号直接跳过，剩余部分继续解析。
    while (this.index < this.tokens.length) {
      parts.push(this.parseOr());
      if (this.peek()?.type === "close") this.index += 1;
    }
    return and(parts);
  }

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }

  private parseOr(): SearchExpr {
    const options = [this.parseAnd()];
    while (this.peek()?.type === "or") {
      this.index += 1;
      options.push(this.parseAnd());
    }
    return or(options);
  }

  private parseAnd(): SearchExpr {
    const items: SearchExpr[] = [];
    for (let token = this.peek(); token !== undefined; token = this.peek()) {
      if (token.type === "close" || token.type === "or") break;
      const item = this.parseUnary();
      if (item !== null) items.push(item);
    }
    return and(items);
  }

  private parseUnary(): SearchExpr | null {
    if (this.peek()?.type === "not") {
      this.index += 1;
      const inner = this.parseUnary();
      return inner === null || isEmpty(inner) ? null : { kind: "not", child: inner };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): SearchExpr | null {
    const token = this.peek();
    if (token === undefined) return null;
    this.index += 1;
    switch (token.type) {
      case "open":
        return this.group();
      case "scope": {
        if (this.peek()?.type !== "open") return null;
        this.index += 1;
        const inner = this.group();
        return isEmpty(inner) ? null : { kind: token.kind, child: inner };
      }
      case "regex":
        return { kind: "regex", value: token.source };
      case "bracket":
        return bracket(token.content);
      case "word":
        return word(token.text, token.quoteStart);
      default:
        return null;
    }
  }

  /** 括号内的表达式；缺少右括号时一直读到末尾。 */
  private group(): SearchExpr {
    const inner = this.parseOr();
    if (this.peek()?.type === "close") this.index += 1;
    return inner;
  }
}

function isEmpty(expr: SearchExpr): boolean {
  return expr.kind === "and" && expr.children.length === 0;
}

/** AND：展开嵌套 AND、去掉空条件，单一条件直接返回。 */
function and(items: SearchExpr[]): SearchExpr {
  const children = items.flatMap((item) =>
    isEmpty(item) ? [] : item.kind === "and" ? item.children : [item],
  );
  return children.length === 1 ? (children[0] as SearchExpr) : { kind: "and", children };
}

/** OR：去掉空分支；任一分支为空等于没有备选，按剩余分支处理。 */
function or(items: SearchExpr[]): SearchExpr {
  const children = items.flatMap((item) =>
    isEmpty(item) ? [] : item.kind === "or" ? item.children : [item],
  );
  if (children.length === 0) return EMPTY;
  return children.length === 1 ? (children[0] as SearchExpr) : { kind: "or", children };
}

/** `[键]` 属性存在、`[键:值]` 属性等值；空键按字面全文词处理。 */
function bracket(content: string): SearchExpr {
  const colon = content.indexOf(":");
  const key = (colon < 0 ? content : content.slice(0, colon)).trim();
  if (key === "") return { kind: "term", value: `[${content}]` };
  const value = colon < 0 ? "" : content.slice(colon + 1).trim();
  return { kind: "attr", key, value: value === "" ? null : value };
}

/** 普通词按前缀归类；引号内的内容不参与谓词识别。 */
function word(text: string, quoteStart: number): SearchExpr | null {
  if (text === "") return null;
  const literal = { kind: "term" as const, value: text };
  if (quoteStart === 0) return literal;
  if (text.startsWith("#") && text.length > 1) return { kind: "tag", value: text.slice(1) };
  const colon = text.indexOf(":");
  if (colon <= 0 || (quoteStart >= 0 && colon >= quoteStart)) return literal;
  const key = text.slice(0, colon);
  const value = text.slice(colon + 1);
  if (value === "") return literal;
  switch (key) {
    case "tag":
    case "tags":
      return { kind: "tag", value: value.replace(/^#/, "") };
    case "path":
      return { kind: "path", value };
    case "file":
      return { kind: "file", value };
    case "line":
    case "section":
      return { kind: key, child: { kind: "term", value } };
    default:
      // 属性谓词：键不含 `/` 且值不以 `/` 开头，URL 与盘符路径保持字面。
      return !key.includes("/") && !value.startsWith("/") ? { kind: "attr", key, value } : literal;
  }
}

/**
 * 摘要按控制字符切分为高亮片段；标记不成对时剩余文本按普通片段处理。
 *
 * @param snippet 内核返回的摘要，命中词以 U+0001/U+0002 包围。
 */
export function snippetParts(snippet: string): SnippetPart[] {
  const parts: SnippetPart[] = [];
  let current = "";
  let marked = false;
  for (const ch of snippet) {
    if (ch === "\u{1}" || ch === "\u{2}") {
      if (current !== "") parts.push({ text: current, mark: marked });
      current = "";
      marked = ch === "\u{1}";
      continue;
    }
    current += ch;
  }
  if (current !== "") parts.push({ text: current, mark: marked });
  return parts;
}

/** 表达式里第一个不在取反之下的全文词。 */
function firstPositiveTerm(expr: SearchExpr, negated = false): string | null {
  switch (expr.kind) {
    case "and":
    case "or":
      for (const child of expr.children) {
        const found = firstPositiveTerm(child, negated);
        if (found !== null) return found;
      }
      return null;
    case "not":
      return firstPositiveTerm(expr.child, !negated);
    case "line":
    case "section":
      return firstPositiveTerm(expr.child, negated);
    case "term":
      return negated ? null : expr.value;
    default:
      return null;
  }
}

/**
 * 提取跳转定位用的命中词：优先摘要中第一个高亮片段，其次是第一个正向全文词。
 *
 * 纯谓词查询没有可定位文本，返回空串，调用方只打开文件不定位。
 */
export function matchNeedle(hit: SearchHit, query: SearchQuery): string {
  const marked = snippetParts(hit.snippet).find((part) => part.mark && part.text.trim() !== "");
  if (marked !== undefined) return marked.text;
  return firstPositiveTerm(query.expr) ?? "";
}
