/** 解析与序列化共用语法配置，避免两端对 GFM、公式和转义的理解不同。 */
import remarkGfm from "remark-gfm";
import remarkFrontmatter from "remark-frontmatter";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { unified } from "unified";
import { remarkWiki, type WikiLink } from "./wiki";
import { remarkObsidian } from "./obsidian";
import type { Literal } from "mdast";
import { layoutHandlers, listNeedsParagraphBoundary } from "./layout-serialization";
import { textStyleTags, type StyledText } from "./text-style";

/** 已确认的 Markdown 语法片段；不经过普通文本转义。 */
export type RawMarkdown = Literal & { type: "rawMarkdown"; value: string };

declare module "mdast" {
  interface RootContentMap {
    rawMarkdown: RawMarkdown;
  }
  interface BlockContentMap {
    rawMarkdown: RawMarkdown;
  }
  interface PhrasingContentMap {
    rawMarkdown: RawMarkdown;
  }
}

/** 共用处理器；自定义片段只用于 wiki、Obsidian 方言和未提供富文本编辑的源码。 */
export const markdownProcessor = unified()
  .use(remarkParse)
  .use(remarkFrontmatter, ["yaml", "toml"])
  .use(remarkGfm, { tablePipeAlign: false })
  .use(remarkMath)
  .use(remarkWiki)
  .use(remarkObsidian)
  .use(remarkStringify, {
    bullet: "-",
    emphasis: "*",
    fences: true,
    listItemIndent: "one",
    rule: "-",
    ruleSpaces: false,
    // 空段占一条额外空行；正文到空段先保留普通块所需的分隔空行。
    join: [
      (left, right) => {
        if (left.type === "paragraph" && left.children.length === 0) return 0;
        if (right.type === "paragraph" && right.children.length === 0) return 1;
        // 紧凑列表默认不留空行；引用后的正文会被当作懒延续，必须显式结束引用。
        if (left.type === "blockquote" && right.type === "paragraph") return 1;
        if (left.type === "paragraph" && right.type === "list") {
          const first = right.children[0];
          const lead = first?.children[0];
          // 空列表项与非 1 起始的编号不能打断段落，短横线还可能被误读为标题下划线。
          const empty =
            typeof first?.checked !== "boolean" &&
            (lead === undefined || (lead.type === "paragraph" && lead.children.length === 0));
          if (listNeedsParagraphBoundary(right.ordered ? (right.start ?? 1) : null, empty))
            return 1;
        }
        return undefined;
      },
    ],
    handlers: {
      ...layoutHandlers,
      textStyle: (node: StyledText, _parent, state, info) => {
        const [open, close] = textStyleTags(node.style);
        const content = state.containerPhrasing(node, { ...info, before: ">", after: "<" });
        return open + content + close;
      },
      wikiLink: (node: WikiLink, _parent, state) =>
        state.stack.includes("tableCell") ? node.value.replace(/\|/g, "\\|") : node.value,
      rawMarkdown: (node: RawMarkdown, _parent, state) =>
        state.stack.includes("tableCell") ? node.value.replace(/\|/g, "\\|") : node.value,
    },
  });
