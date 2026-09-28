/**
 * 源码模式的 `[[` 链接补全：与排版编辑器共用同一候选排序（candidates.ts）。
 *
 * 文件目标同步产出；标题锚点（`[[note#`）与块（`[[note#^`）需要跨进程解析目标文件，
 * 由注入的加载器异步提供，未注入时 `#` 之后不弹候选。别名命中写成 `[[目标|别名]]`。
 * 选中候选后自动补 `]]`（光标后已有闭合时不重复）。
 */

import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { NoteKeys } from "../../../../shared/api";
import {
  listSourceBlocks,
  newBlockId,
  takenBlockIds,
  type BlockCandidate,
  type BlockTarget,
} from "../../../links/block-list";
import { rankBlockCandidates, rankFileCandidates, rankHeadingCandidates } from "./candidates";

/** 候选的插入文本：光标后没有 `]]` 时补上闭合。 */
function closing(view: EditorView, to: number, value: string): string {
  const after = view.state.sliceDoc(to, Math.min(to + 2, view.state.doc.length));
  return after === "]]" ? value : `${value}]]`;
}

/** 候选的插入行为：替换查询区间。 */
function applyWithClosing(value: string) {
  return (view: EditorView, _completion: Completion, from: number, to: number): void => {
    const insert = closing(view, to, value);
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + insert.length },
    });
  };
}

/** 源码模式补全的可选数据源；未提供的部分对应补全不出现。 */
export type SourceLinkSources = {
  /** 解析目标并返回其标题文本；失败或无标题时返回空列表。 */
  headings?: (target: string) => Promise<string[]>;
  /** 笔记标题与别名，实时读取。 */
  aliases?: () => readonly NoteKeys[];
  /** 块补全目标；本笔记由源码直接处理。 */
  blocks?: (target: string) => Promise<BlockTarget | null>;
  /** 确保其他笔记里的块带 ID；失败时提供方报告并返回 null。 */
  ensureBlockId?: (path: string, block: BlockCandidate) => Promise<string | null>;
};

/**
 * 块候选的插入：本笔记在同一事务里给块追加 ID 并写链接；
 * 其他笔记先落实 ID，查询区间未变时再写链接。
 */
function applyBlock(target: BlockTarget, block: BlockCandidate, sources: SourceLinkSources) {
  return (view: EditorView, _completion: Completion, from: number, to: number): void => {
    if (target.kind === "self") {
      const id = block.id ?? newBlockId(takenBlockIds(listSourceBlocks(view.state.doc.toString())));
      const insert = closing(view, to, `^${id}`);
      const marker = block.id === null ? ` ^${id}` : "";
      const shift = marker !== "" && block.insertAt <= from ? marker.length : 0;
      view.dispatch({
        changes: [
          ...(marker === "" ? [] : [{ from: block.insertAt, insert: marker }]),
          { from, to, insert },
        ],
        selection: { anchor: from + shift + insert.length },
      });
      return;
    }
    const original = view.state.sliceDoc(from, to);
    void (sources.ensureBlockId?.(target.path, block) ?? Promise.resolve(block.id)).then((id) => {
      if (id === null || view.state.sliceDoc(from, to) !== original) return;
      const insert = closing(view, to, `^${id}`);
      view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length } });
    });
  };
}

/**
 * 创建 Markdown 源码的 wiki 链接补全扩展。
 *
 * @param files 实时读取的库内文件列表；每次触发时过滤 `.md`。
 * @param sources 标题、别名与块的数据源。
 */
export function markdownLinkCompletion(
  files: () => readonly string[],
  sources: SourceLinkSources = {},
): Extension {
  return autocompletion({
    activateOnTyping: true,
    override: [
      async (context: CompletionContext): Promise<CompletionResult | null> => {
        const line = context.state.doc.lineAt(context.pos);
        const before = line.text.slice(0, context.pos - line.from);
        const trigger = before.lastIndexOf("[[");
        if (trigger < 0) return null;
        const query = before.slice(trigger + 2);
        // 已闭合与别名段不补全；转义的 \[[ 是字面文本。
        if (query.includes("]]") || query.includes("|")) return null;
        let backslashes = 0;
        for (let index = trigger - 1; index >= 0 && before[index] === "\\"; index -= 1)
          backslashes += 1;
        if (backslashes % 2 === 1) return null;
        const from = line.from + trigger + 2;
        const hash = query.lastIndexOf("#");
        if (hash >= 0 && query[hash + 1] === "^") {
          const target = query.slice(0, hash);
          let resolved: BlockTarget | null = target.trim() === "" ? { kind: "self" } : null;
          if (resolved === null && sources.blocks !== undefined) {
            try {
              resolved = await sources.blocks(target);
            } catch {
              // 加载器约定失败返回 null；双重防护，避免未处理的拒绝。
            }
          }
          if (resolved === null) return null;
          const blocks =
            resolved.kind === "self"
              ? listSourceBlocks(context.state.doc.toString())
              : resolved.blocks;
          const found = resolved;
          const options = rankBlockCandidates(query.slice(hash + 2), blocks).flatMap(
            (item): Completion[] => {
              const block = blocks[Number(item.value)];
              if (block === undefined) return [];
              return [
                {
                  label: item.label,
                  detail: item.detail,
                  type: "text",
                  apply: applyBlock(found, block, sources),
                },
              ];
            },
          );
          return options.length === 0 ? null : { from: from + hash + 2, options, filter: false };
        }
        if (hash >= 0) {
          const target = query.slice(0, hash);
          if (sources.headings === undefined || target.trim() === "") return null;
          let texts: string[] = [];
          try {
            texts = await sources.headings(target);
          } catch {
            // 加载器约定失败返回空列表；双重防护，避免未处理的拒绝。
          }
          const options = rankHeadingCandidates(query.slice(hash + 1), texts).map(
            (item): Completion => ({
              label: item.label,
              detail: item.detail,
              type: "heading",
              apply: applyWithClosing(item.value),
            }),
          );
          return options.length === 0 ? null : { from: from + hash + 1, options, filter: false };
        }
        const options = rankFileCandidates(
          query,
          files().filter((path) => path.toLowerCase().endsWith(".md")),
          sources.aliases?.() ?? [],
        ).map((item): Completion => ({
          label: item.label,
          detail: item.detail,
          type: "file",
          apply: applyWithClosing(
            item.alias === undefined ? item.value : `${item.value}|${item.alias}`,
          ),
        }));
        return options.length === 0 ? null : { from, options, filter: false };
      },
    ],
  });
}
