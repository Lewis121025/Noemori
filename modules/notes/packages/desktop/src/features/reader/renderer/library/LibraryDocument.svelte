<script lang="ts">
  import { untrack } from "svelte";
  import { EditorState, TextSelection } from "prosemirror-state";
  import { EditorView } from "prosemirror-view";
  import { search, SearchQuery, setSearchState } from "prosemirror-search";
  import { parseMarkdown } from "../../shared/markdown/parse";
  import { createContentNodeViews } from "../markdown/views/content-view";
  import { documentAccess } from "../editor/read-only";
  import { frontmatterPresentation } from "../editor/properties/frontmatter-presentation";
  import { linkInteraction, type OpenContentLink } from "../editor/links/link-interaction";
  import { calloutRevealPlugin, footnoteNavigation } from "../markdown/views/dialect-view";
  import {
    searchMatches,
    findNextMatch,
    findPreviousMatch,
  } from "../editor/search/search-navigation";
  import { conversationRange } from "../editor/agent/insertion";
  import ConversationPreview from "../editor/agent/ConversationPreview.svelte";
  import type { ArticleEditorActions } from "../../shared/article-conversations";
  import type { MediaIo } from "../preview/media";

  let {
    path,
    source,
    query,
    io,
    openLink,
    actions,
    onMatches,
  }: {
    path: string;
    source: string;
    query: string;
    io: MediaIo;
    openLink: OpenContentLink;
    actions?: Pick<ArticleEditorActions, "preview" | "open" | "report">;
    onMatches: (state: { count: number; current: number }) => void;
  } = $props();
  let host: HTMLDivElement;
  let view = $state.raw<EditorView | null>(null);
  let editorState = $state.raw<EditorState | null>(null);
  $effect(() => {
    const file = path,
      text = source,
      media = io;
    return untrack(() => {
      const editor = new EditorView(host, {
        attributes: { "data-content-path": file },
        state: EditorState.create({
          doc: parseMarkdown(text),
          plugins: [
            documentAccess(true),
            frontmatterPresentation(),
            search(),
            linkInteraction((kind, raw) => openLink(kind, raw, file)),
            calloutRevealPlugin(),
            footnoteNavigation(),
          ],
        }),
        nodeViews: createContentNodeViews(file, openLink, media),
        dispatchTransaction(transaction) {
          editor.updateState(editor.state.apply(transaction));
          editorState = editor.state;
        },
      });
      view = editor;
      editorState = editor.state;
      return () => {
        editor.destroy();
        view = null;
        editorState = null;
      };
    });
  });
  $effect(() => {
    const editor = view,
      text = query;
    if (editor)
      untrack(() =>
        editor.dispatch(
          setSearchState(editor.state.tr, new SearchQuery({ search: text.trim(), literal: true })),
        ),
      );
  });
  $effect(() => {
    const snapshot = editorState;
    const matches = snapshot ? searchMatches(snapshot) : [];
    onMatches({
      count: matches.length,
      current: snapshot
        ? matches.findIndex(
            (item) => item.from === snapshot.selection.from && item.to === snapshot.selection.to,
          ) + 1
        : 0,
    });
  });
  /** 上下跳转只改变预览选区，保留搜索框或按钮的键盘焦点；空结果不操作。 */
  export function moveMatch(direction: "next" | "previous"): void {
    if (!view) return;
    (direction === "next" ? findNextMatch : findPreviousMatch)(view.state, view.dispatch);
  }
  /** 返回唯一的文章对话标记；标记删除或重复时返回 false，不猜测段落位置。 */
  export function returnToConversation(id: string): boolean {
    if (!view) return false;
    const range = conversationRange(view.state.doc, id);
    if (!range) return false;
    view.dispatch(
      view.state.tr
        .setSelection(TextSelection.create(view.state.doc, range.from, range.to))
        .scrollIntoView(),
    );
    return true;
  }
</script>

<div class="library-document" bind:this={host}></div>
{#if view && editorState && actions}<ConversationPreview
    {view}
    state={editorState}
    {actions}
  />{/if}

<style>
  .library-document {
    --font-reading: 15px;
    --line-reading: 1.95;
  }
  .library-document :global(.ProseMirror) {
    padding: 0;
    outline-offset: 6px;
  }
  .library-document :global(.ProseMirror-search-match) {
    background: color-mix(in srgb, var(--accent) 15%, transparent);
  }
  .library-document :global(h1 .ProseMirror-search-match) {
    background: transparent;
    text-decoration: underline;
    text-decoration-color: color-mix(in srgb, var(--accent) 35%, transparent);
    text-decoration-thickness: 2px;
    text-underline-offset: 5px;
  }
  .library-document :global(h2) {
    font-size: 14px;
    font-family: system-ui, sans-serif;
    font-weight: 500;
    margin: 24px 0 8px;
  }
  .library-document :global(.ProseMirror-active-search-match) {
    background: color-mix(in srgb, var(--accent) 30%, var(--bg));
    box-shadow: 0 0 0 1px var(--accent);
  }
  .library-document :global(a[href^="noemori://conversation/"]) {
    color: var(--accent);
    font-size: 0.85em;
    text-decoration: none;
    border-bottom: 1px dotted var(--accent);
  }
</style>
