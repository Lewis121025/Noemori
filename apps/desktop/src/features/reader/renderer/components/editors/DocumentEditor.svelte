<script lang="ts">
  /**
   * 可编辑 Markdown 表面：ProseMirror 挂载一次，不把文档树放进 Svelte VDOM。
   */
  import { untrack } from "svelte";
  import { baseKeymap } from "prosemirror-commands";
  import { undo, redo, history, undoDepth, redoDepth } from "prosemirror-history";
  import { keymap } from "prosemirror-keymap";
  import { EditorState, TextSelection } from "prosemirror-state";
  import { EditorView } from "prosemirror-view";
  import { search } from "prosemirror-search";
  import "prosemirror-view/style/prosemirror.css";
  import type { MarkdownEditorApi } from "../../engine/editing/editor-api";
  import { createHtmlNodeViews } from "../../engine/rendering/html-view";
  import { createImageNodeViews } from "../../engine/rendering/image-view";
  import { createPdfNodeViews } from "../../engine/rendering/pdf-view";
  import { createPlayerNodeViews } from "../../engine/rendering/media-view";
  import { mathInputPlugins, mathNodeViews } from "../../engine/rendering/math-view";
  import {
    calloutNodeViews,
    commentNodeViews,
    createCodeBlockViews,
    footnoteNavigation,
    mermaidFocusPlugin,
  } from "../../engine/rendering/dialect-view";
  import { createMarkdownSession } from "../../engine/markdown/source-session";
  import { findHeadingPmPos } from "../../engine/navigation/heading-anchor";
  import { findBlockPmPos } from "../../engine/navigation/block-anchor";
  import { createNoteEmbedViews } from "../../engine/rendering/note-embed-view";
  import { findMentionPmPos } from "../../engine/navigation/mention-jump";
  import { findSearchMatchPmPos } from "../../engine/search/locate";
  import { type MediaIo, resolveMediaUrl } from "../../engine/media/media";
  import { collectOutline, type OutlineItem } from "../../engine/navigation/outline";
  import { writingPlugins } from "../../engine/editing/writing";
  import { taskItemView } from "../../engine/rendering/task-view";
  import { createSourceEditingPlugin } from "../../engine/editing/source-editing";
  import { linkInteraction } from "../../engine/editing/link-interaction";
  import { createLinkSelectionPlugin } from "../../engine/editing/link-editing";
  import {
    captureMarkdownReload,
    prepareMarkdownReload,
    type MarkdownReloadContext,
  } from "../../engine/editing/markdown-reload";
  import { applyMarkdownHistory, nativeInputOwnsHistory } from "../../engine/editing/history";
  import { suggestRequest, type SuggestRequest } from "../../engine/editing/link-suggest/context";
  import {
    rankBlockCandidates,
    rankFileCandidates,
    rankHeadingCandidates,
    type LinkSuggestion,
  } from "../../engine/editing/link-suggest/candidates";
  import { linkSuggestPlugin, type SuggestKeymap } from "../../engine/editing/link-suggest/plugin";
  import { suggestInsertion } from "../../engine/editing/link-suggest/insert";
  import EditorFormatting from "./EditorFormatting.svelte";
  import SelectionFormatting from "./SelectionFormatting.svelte";
  import EditorLink from "./EditorLink.svelte";
  import EditorSearch from "./EditorSearch.svelte";
  import EditorAttachments from "./EditorAttachments.svelte";
  import LinkSuggestPopup from "./LinkSuggestPopup.svelte";
  import PropertiesPanel from "./PropertiesPanel.svelte";
  import {
    createAttachmentEditing,
    type AttachmentProgress,
  } from "../../engine/editing/attachments";
  import type { AttachmentImporter } from "../../../shared/attachments";
  import type { LinkKind, NoteKeys } from "../../../shared/api";
  import {
    listDocBlocks,
    newBlockId,
    takenBlockIds,
    type BlockCandidate,
    type BlockTarget,
  } from "../../engine/navigation/block-list";

  type Props = {
    /** 阅读器注入的资源访问能力，编辑器不依赖宿主应用。 */
    mediaIo: MediaIo;
    /** 已捕获文档身份的附件字节导入能力。 */
    importAttachment: AttachmentImporter;
    /** 导入后警告跨文档显示，告知已经落盘但尚未插入的附件位置。 */
    onAttachmentReport: (message: string) => void;
    /** 附件事务结束后重新检查等待中的外部版本，不改变文档内容。 */
    onAttachmentSettled?: () => void;
    /** 当前笔记的库内相对路径，用来解析相对图片。 */
    path: string;
    /** 打开文件时的 Markdown 文本；变化则重建视图。 */
    source: string;
    /** 无法映射为源码时保存的初始恢复内容；实时内容仍只属于当前编辑会话。 */
    recovery?: string | undefined;
    /** 文档被用户改动时调用。 */
    onDirty: () => void;
    /** 保存快捷键。 */
    onSave: () => void;
    /**
     * 点击内部链接。
     *
     * @param kind wiki 或 Markdown 链接。
     * @param raw 目标原文（wiki 名为 target，md 为 href）。
     */
    onOpenLink: (kind: "wiki" | "md", raw: string) => void;
    /** 文档大纲变化时调用；卸载时传空数组。 */
    onOutline: (items: OutlineItem[]) => void;
    /** 注册/注销序列化入口。 */
    register: (api: MarkdownEditorApi | null) => void;
    /**
     * 格式面板 DOM id。
     *
     * 工具栏的 Aa 用 popovertarget 指向它；分栏同时挂载多篇文档时必须各不相同。
     */
    formattingId?: string;
    /** 本栏是否为活动栏。失去活动时关闭格式面板，避免弹层还作用在背后那一栏。 */
    active?: boolean;
    /** 阅读视图：同一编辑器切为只读，链接单击即打开，任务仍可勾选。 */
    readOnly?: boolean;
    /** 库内链接候选；仅用于交互，不参与文档挂载依赖。 */
    linkTargets?: string[];
    /**
     * 解析锚点补全的目标并返回其标题文本。
     *
     * 目标解析失败或没有标题时返回空列表；异常由提供方吞掉并降级为空候选，
     * 补全是尽力而为的辅助能力，不打断写作。
     */
    suggestHeadings?: (target: string, syntax: LinkKind) => Promise<string[]>;
    /** 笔记标题与别名；有查询时别名参与文件补全。 */
    linkAliases?: readonly NoteKeys[];
    /** 块补全的目标；本笔记由编辑器按当前文档处理，失败返回 null。 */
    suggestBlocks?: (target: string, syntax: LinkKind) => Promise<BlockTarget | null>;
    /** 确保其他笔记里的块带 ID；失败时提供方负责报告并返回 null。 */
    ensureBlockId?: (path: string, block: BlockCandidate) => Promise<string | null>;
  };

  let {
    mediaIo,
    importAttachment,
    onAttachmentReport,
    onAttachmentSettled,
    path,
    source,
    recovery,
    onDirty,
    onSave,
    onOpenLink,
    onOutline,
    register,
    linkTargets = [],
    suggestHeadings,
    linkAliases = [],
    suggestBlocks,
    ensureBlockId,
    formattingId = "editor-formatting",
    active = true,
    readOnly = false,
  }: Props = $props();
  let host: HTMLDivElement | undefined = $state();
  let editor = $state.raw<EditorView | null>(null);
  let editorState = $state.raw<EditorState | null>(null);
  let showLink = $state(false);
  let showSearch = $state(false);
  let formattingOpen = $state(false);
  let searchPanel: EditorSearch | undefined = $state();
  let formattingPanel: EditorFormatting | undefined = $state();
  let attachmentPanel: EditorAttachments | undefined = $state();
  let attachments = $state.raw<ReturnType<typeof createAttachmentEditing> | null>(null);
  let attachmentProgress = $state<AttachmentProgress>(null);
  let previous: MarkdownReloadContext | null = null;

  /** 内联补全弹层状态；null 表示未触发。 */
  type SuggestState = {
    request: SuggestRequest;
    items: LinkSuggestion[];
    selected: number;
    x: number;
    top: number | null;
    bottom: number | null;
  };
  let suggest = $state<SuggestState | null>(null);
  let suggestGeneration = 0;
  /** 当前块补全所依据的清单；选中时按序号取回块，写入前再核对文字。 */
  let blockSource: { target: string; resolved: BlockTarget; blocks: BlockCandidate[] } | null =
    null;

  const suggestKeys: SuggestKeymap = {
    active: () => suggest !== null && suggest.items.length > 0,
    move: (delta) => {
      const current = suggest;
      if (current === null || current.items.length === 0) return;
      const count = current.items.length;
      suggest = { ...current, selected: (current.selected + delta + count) % count };
    },
    choose: () => chooseSuggestion(null),
    cancel: () => closeSuggest(),
  };

  function closeSuggest(): void {
    suggest = null;
    suggestGeneration += 1;
  }

  /**
   * 每次状态更新后重算补全上下文；文件候选同步产出，
   * 标题候选异步加载并按代次丢弃过期响应。
   */
  function refreshSuggest(view: EditorView, state: EditorState): void {
    const request = suggestRequest(state);
    // 离开块查询后清单作废；下次进入重新读取，避免引用到已变化的旧清单。
    if (request?.kind !== "block") blockSource = null;
    if (request === null) {
      closeSuggest();
      return;
    }
    // jsdom 没有布局；真实窗口极少数位置 coordsAtPos 也可能抛错，退化到原点。
    let coords = { left: 0, top: 0, bottom: 0 };
    try {
      coords = view.coordsAtPos(request.from);
    } catch {
      // 保留默认坐标，弹层仍然可用。
    }
    const flip = coords.bottom + 288 > window.innerHeight;
    const placed = {
      x: Math.min(Math.max(coords.left, 8), Math.max(8, window.innerWidth - 348)),
      top: flip ? null : coords.bottom + 4,
      bottom: flip ? Math.max(window.innerHeight - coords.top + 4, 0) : null,
    };
    if (request.kind === "file") {
      suggest = {
        request,
        items: rankFileCandidates(request.query, linkTargets, linkAliases),
        selected: 0,
        ...placed,
      };
      return;
    }
    if (request.kind === "block") {
      refreshBlockSuggest(view, request, placed);
      return;
    }
    // 同一目标的标题异步加载期间保留旧候选，避免闪烁。
    const previousItems =
      suggest !== null &&
      suggest.request.kind === "heading" &&
      suggest.request.target === request.target
        ? suggest.items
        : [];
    suggest = { request, items: previousItems, selected: 0, ...placed };
    const loader = suggestHeadings;
    if (loader === undefined) return;
    const generation = ++suggestGeneration;
    void (async () => {
      let headings: string[] = [];
      try {
        headings = await loader(request.target, request.syntax);
      } catch {
        // 提供方约定失败返回空列表；双重防护，避免未处理的拒绝。
      }
      const current = suggest;
      if (generation !== suggestGeneration || current === null) return;
      const items = rankHeadingCandidates(request.query, headings);
      suggest = {
        ...current,
        items,
        selected: Math.min(current.selected, Math.max(items.length - 1, 0)),
      };
    })();
  }

  /**
   * 块候选：同一目标的清单只取一次，之后随查询本地重排；
   * 本笔记直接读当前文档，包含尚未保存的编辑。
   */
  function refreshBlockSuggest(
    view: EditorView,
    request: SuggestRequest,
    placed: Pick<SuggestState, "x" | "top" | "bottom">,
  ): void {
    if (request.kind !== "block") return;
    const show = (blocks: BlockCandidate[]) => {
      suggest = {
        request,
        items: rankBlockCandidates(request.query, blocks),
        selected: 0,
        ...placed,
      };
    };
    if (blockSource !== null && blockSource.target === request.target) {
      const blocks =
        blockSource.resolved.kind === "self" ? listDocBlocks(view.state.doc) : blockSource.blocks;
      blockSource = { ...blockSource, blocks };
      show(blocks);
      return;
    }
    if (request.target.trim() === "") {
      const blocks = listDocBlocks(view.state.doc);
      blockSource = { target: request.target, resolved: { kind: "self" }, blocks };
      show(blocks);
      return;
    }
    suggest = { request, items: [], selected: 0, ...placed };
    const loader = suggestBlocks;
    if (loader === undefined) return;
    const generation = ++suggestGeneration;
    void loader(request.target, request.syntax).then((resolved) => {
      const current = suggest;
      if (generation !== suggestGeneration || current === null || resolved === null) return;
      const blocks = resolved.kind === "self" ? listDocBlocks(view.state.doc) : resolved.blocks;
      blockSource = { target: request.target, resolved, blocks };
      const latest = suggestRequest(view.state);
      if (latest?.kind === "block") show(blocks);
    });
  }

  /**
   * 本笔记的块：没有 ID 时在编辑器里追加，交给自动保存。
   *
   * @param trigger 链接触发串起点；追加 ID 可能发生在它之前，返回映射后的新位置。
   */
  function ensureSelfBlockId(
    view: EditorView,
    block: BlockCandidate,
    trigger: number,
  ): { id: string; trigger: number } | null {
    if (block.id !== null) return { id: block.id, trigger };
    const blocks = listDocBlocks(view.state.doc);
    const current = blocks[block.index];
    if (current === undefined || current.text !== block.text) return null;
    if (current.id !== null) return { id: current.id, trigger };
    const id = newBlockId(takenBlockIds(blocks));
    const tr = view.state.tr.insertText(` ^${id}`, current.insertAt);
    view.dispatch(tr);
    return { id, trigger: tr.mapping.map(trigger) };
  }

  /** 提交候选；事务构造与保真契约见 `suggestInsertion`。范围失效只关弹层。 */
  function chooseSuggestion(index: number | null): void {
    const current = suggest;
    const view = editor;
    if (current === null || view === null) return;
    const chosen = current.items[index ?? current.selected];
    closeSuggest();
    if (chosen === undefined) return;
    if (current.request.kind === "block") {
      void chooseBlock(view, current.request, chosen);
      return;
    }
    const tr = suggestInsertion(view.state, current.request, chosen.value, chosen.alias ?? null);
    if (tr === null) return;
    view.dispatch(tr);
    view.focus();
  }

  /**
   * 块候选需要先落实 ID（可能写入其他笔记），完成后按当前状态重新识别触发范围；
   * 用户在等待期间离开了链接语法就不再插入。
   */
  async function chooseBlock(
    view: EditorView,
    request: SuggestRequest,
    chosen: LinkSuggestion,
  ): Promise<void> {
    if (request.kind === "file") return;
    const source = blockSource;
    const block = source?.blocks[Number(chosen.value)];
    if (source === null || block === undefined) return;
    let ensured: { id: string; trigger: number } | null;
    if (source.resolved.kind === "self")
      ensured = ensureSelfBlockId(view, block, request.triggerFrom);
    else {
      const id = (await ensureBlockId?.(source.resolved.path, block)) ?? null;
      ensured = id === null ? null : { id, trigger: request.triggerFrom };
    }
    blockSource = null;
    if (ensured === null || view.isDestroyed) return;
    const latest = suggestRequest(view.state);
    if (
      latest?.kind !== "block" ||
      latest.triggerFrom !== ensured.trigger ||
      latest.target !== request.target
    )
      return;
    const tr = suggestInsertion(view.state, latest, `^${ensured.id}`);
    if (tr === null) return;
    view.dispatch(tr);
    view.focus();
  }

  function openAttachments(): void {
    formattingPanel?.dismiss();
    attachmentPanel?.pick();
  }

  function openSearch(): void {
    formattingPanel?.dismiss();
    showSearch = true;
    searchPanel?.focusQuery();
  }

  // 活动栏切走后，已打开的格式面板仍绑定着这一栏的编辑器，必须关掉。
  $effect(() => {
    if (!active) formattingPanel?.dismiss();
  });

  // 排版与阅读共用同一视图：只切换可编辑性，不重建编辑器、不丢撤销历史与滚动位置。
  $effect(() => {
    const locked = readOnly;
    const view = editor;
    if (view === null) return;
    view.setProps({ editable: () => !locked });
    if (locked) {
      formattingPanel?.dismiss();
      showLink = false;
      closeSuggest();
    }
  });

  $effect(() => {
    const el = host;
    const src = source;
    const recovered = recovery;
    const notePath = path;
    if (el === undefined) {
      return;
    }
    // 先记下 host/path/source。后面创建视图并调用 onOutline：
    // 回调会读/写外壳的 outline，算进依赖就会「写大纲 → 重跑 effect → 清空 → 再挂载」死循环。
    return untrack(() => {
      const save = onSave;
      const dirty = onDirty;
      const openLink = onOpenLink;
      const pushOutline = onOutline;
      const bindApi = register;
      const loadMd = (raw: string) => resolveMediaUrl(notePath, raw, "md", mediaIo);
      const loadAny = (raw: string, kind: "md" | "wiki") =>
        resolveMediaUrl(notePath, raw, kind, mediaIo);
      const session = createMarkdownSession(src, recovered);
      const doc = session.doc;
      const reload = previous === null ? null : prepareMarkdownReload(previous, doc);
      previous = null;
      const attachmentEditing = createAttachmentEditing({
        // 同路径的会话版本可能因文件操作更新；发起导入时使用当前身份，销毁仍取消迟到请求。
        import: (name, bytes) => importAttachment(name, bytes),
        progress: (progress) => {
          attachmentProgress = progress;
        },
        report: onAttachmentReport,
        settled: () => onAttachmentSettled?.(),
      });
      attachments = attachmentEditing;
      const locked = readOnly;
      const created = new EditorView(el, {
        editable: () => !locked,
        state: EditorState.create({
          doc,
          ...(reload === null ? {} : { selection: reload.selection }),
          plugins: [
            // 补全弹层激活时优先接管导航键；未激活时完全透明。
            linkSuggestPlugin(suggestKeys),
            history(),
            attachmentEditing.plugin,
            search(),
            createSourceEditingPlugin(reload?.sourceEditing),
            createLinkSelectionPlugin(reload?.bookmark),
            linkInteraction(openLink),
            footnoteNavigation(),
            mermaidFocusPlugin(),
            ...mathInputPlugins(),
            ...writingPlugins({
              link: () => {
                showLink = true;
              },
              search: openSearch,
            }),
            keymap({
              "Mod-s": () => {
                save();
                return true;
              },
              "Mod-z": undo,
              "Mod-y": redo,
              "Mod-Shift-z": redo,
            }),
            keymap(baseKeymap),
          ],
        }),
        nodeViews: {
          list_item: taskItemView,
          ...mathNodeViews,
          ...commentNodeViews,
          ...calloutNodeViews,
          ...createCodeBlockViews(),
          ...createHtmlNodeViews(loadMd),
          ...createImageNodeViews(loadAny),
          ...createPdfNodeViews(notePath, openLink, mediaIo),
          ...createPlayerNodeViews(notePath, mediaIo),
          ...createNoteEmbedViews(notePath, openLink, mediaIo),
        },
        dispatchTransaction(tr) {
          const { state: next, transactions } = created.state.applyTransaction(tr);
          for (const transaction of transactions) session.track(transaction);
          created.updateState(next);
          editorState = next;
          if (transactions.some((transaction) => transaction.docChanged)) {
            dirty();
            pushOutline(collectOutline(next.doc));
          }
          refreshSuggest(created, next);
        },
      });
      const stopRestoring = reload?.restore(created);
      editor = created;
      editorState = created.state;
      pushOutline(collectOutline(created.state.doc));
      bindApi({
        history: (action) => applyMarkdownHistory(created, action),
        historyAvailability: () => {
          if (nativeInputOwnsHistory(created.dom)) return null;
          const state = editorState;
          return {
            undo: state !== null && undoDepth(state) > 0,
            redo: state !== null && redoDepth(state) > 0,
          };
        },
        focus: () => created.focus(),
        openSearch,
        openAttachments,
        settleAttachments: attachmentEditing.settle,
        snapshot: () => session.snapshot(created.state.doc),
        jumpTo: (pos) => {
          jumpEditor(created, pos, "start");
        },
        jumpToMention: (mention, occurrence) => {
          const pos = findMentionPmPos(created.state.doc, mention, occurrence);
          if (pos === null) {
            return;
          }
          jumpEditor(created, pos, "center");
        },
        jumpToText: (needle) => {
          const pos = findSearchMatchPmPos(created.state.doc, needle);
          if (pos === null) {
            return;
          }
          jumpEditor(created, pos, "center");
        },
        jumpToHeading: (anchor) => {
          const pos = anchor.startsWith("^")
            ? findBlockPmPos(created.state.doc, anchor.slice(1))
            : findHeadingPmPos(created.state.doc, anchor);
          if (pos === null) {
            return false;
          }
          jumpEditor(created, pos, "start");
          return true;
        },
        currentHeading: () => {
          const from = created.state.selection.from;
          return (
            collectOutline(created.state.doc).findLast((item) => item.pos < from)?.text ?? null
          );
        },
      });
      return () => {
        stopRestoring?.();
        previous = captureMarkdownReload(created);
        pushOutline([]);
        bindApi(null);
        closeSuggest();
        editor = null;
        editorState = null;
        attachments = null;
        attachmentProgress = null;
        created.destroy();
        el.replaceChildren();
      };
    });
  });

  function jumpEditor(view: EditorView, pos: number, block: ScrollLogicalPosition): void {
    const { doc } = view.state;
    if (pos < 0 || pos >= doc.content.size) {
      return;
    }
    const resolved = doc.resolve(Math.min(pos + 1, doc.content.size));
    view.dispatch(view.state.tr.setSelection(TextSelection.near(resolved)).scrollIntoView());
    view.focus();
    const nodeDom = view.nodeDOM(pos);
    if (nodeDom instanceof HTMLElement) {
      // 目录要对齐到阅读区顶部。PM 的 scrollIntoView 只保证「勉强看见」，标题会被贴在底部。
      // 入链命中落在段落里，居中更容易看见。
      nodeDom.scrollIntoView({ block, inline: "nearest" });
      return;
    }
    const scroller = view.dom.closest(".main");
    if (!(scroller instanceof HTMLElement)) {
      return;
    }
    // jsdom 的 Text 没有 getClientRects；真实窗口里极少数位置也会让 coordsAtPos 扔。
    // 上面事务已经 scrollIntoView，这里只是尽量居中。
    let coords: { top: number; bottom: number };
    try {
      coords = view.coordsAtPos(pos);
    } catch {
      return;
    }
    const rect = scroller.getBoundingClientRect();
    if (block === "start") {
      scroller.scrollTop += coords.top - rect.top;
      return;
    }
    const mid = (coords.top + coords.bottom) / 2;
    scroller.scrollTop += mid - (rect.top + rect.height / 2);
  }
</script>

{#if editor !== null && editorState !== null}
  <EditorFormatting
    bind:this={formattingPanel}
    id={formattingId}
    view={editor}
    state={editorState}
    onLink={() => (showLink = true)}
    onAttachment={openAttachments}
    onOpenChange={(open) => (formattingOpen = open)}
  />
  {#if attachments}<EditorAttachments
      bind:this={attachmentPanel}
      view={editor}
      editing={attachments}
      progress={attachmentProgress}
    />{/if}
  <SelectionFormatting
    view={editor}
    state={editorState}
    blocked={readOnly || showSearch || showLink || formattingOpen}
    onLink={() => (showLink = true)}
  />
  {#if showSearch}<EditorSearch
      bind:this={searchPanel}
      view={editor}
      state={editorState}
      onClose={() => (showSearch = false)}
    />{/if}
  {#if showLink}<EditorLink
      view={editor}
      targets={linkTargets}
      onClose={() => (showLink = false)}
    />{/if}
  <PropertiesPanel view={editor} state={editorState} {readOnly} />
{/if}
<div class="surface" class:reading={readOnly} bind:this={host}></div>
{#if suggest !== null && suggest.items.length > 0}
  <LinkSuggestPopup
    items={suggest.items}
    selected={suggest.selected}
    x={suggest.x}
    top={suggest.top}
    bottom={suggest.bottom}
    onChoose={(index) => chooseSuggestion(index)}
    onHover={(index) => {
      const current = suggest;
      if (current !== null) suggest = { ...current, selected: index };
    }}
  />
{/if}

<style>
  .surface {
    min-height: 16rem;
  }

  .surface :global(.ProseMirror) {
    outline: none;
    min-height: 16rem;
    padding: 0.5rem;
    font-size: var(--font-reading);
    line-height: var(--line-reading);
  }

  .surface :global(.ProseMirror :is(h1, h2, h3, h4, h5, h6)) {
    line-height: 1.35;
    font-weight: 600;
    letter-spacing: -0.02em;
    margin: 1.8em 0 0.65em;
  }

  .surface :global(.ProseMirror h1) {
    font-size: 30px;
  }
  .surface :global(.ProseMirror h2) {
    font-size: 24px;
  }
  .surface :global(.ProseMirror h3) {
    font-size: 20px;
  }
  .surface :global(.ProseMirror :is(h4, h5, h6)) {
    font-size: 17px;
  }
  .surface :global(.ProseMirror > :first-child) {
    margin-top: 0.5rem;
  }
  .surface :global(.ProseMirror p) {
    margin: 0.85em 0;
  }
  .surface :global(.ProseMirror :is(ul, ol)) {
    padding-left: 1.6em;
    margin: 1em 0;
  }
  .surface :global(.ProseMirror li + li) {
    margin-top: 0.3em;
  }
  .surface :global(.ProseMirror :is(ul, ol) :is(ul, ol)) {
    margin: 0.3em 0;
  }

  .surface :global(.ProseMirror blockquote) {
    margin: 1.2em 0;
    padding-left: 1rem;
    border-left: 2px solid var(--border);
    color: var(--muted);
  }

  .surface :global(.ProseMirror code) {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.9em;
    background: var(--sidebar);
    border-radius: 0.25rem;
    padding: 0.1em 0.3em;
  }

  .surface :global(.ProseMirror pre) {
    padding: 1rem;
    background: var(--sidebar);
    border-radius: 0.6rem;
    line-height: 1.6;
    overflow-x: auto;
  }

  .surface :global(.ProseMirror pre code) {
    padding: 0;
    background: transparent;
  }

  .surface :global(.wiki-link) {
    text-decoration: underline;
    cursor: text;
  }

  .surface :global(.ProseMirror a) {
    color: inherit;
    cursor: text;
  }

  .surface :global(.math-inline) {
    display: inline-block;
    vertical-align: middle;
    cursor: text;
  }

  .surface :global(.math-block) {
    display: block;
    margin: 0.5rem 0;
    overflow-x: auto;
    cursor: text;
  }

  .surface :global(.html-inline) {
    display: inline;
    cursor: text;
  }

  .surface :global(.html-block) {
    display: block;
    margin: 0.5rem 0;
    cursor: text;
  }

  .surface :global(.media-embed) {
    display: inline-block;
    max-width: 100%;
    color: var(--muted);
    font-size: 0.85em;
  }
  .surface :global(.media-audio) {
    width: min(100%, 28rem);
  }
  .surface :global(.media-audio audio) {
    width: 100%;
  }
  .surface :global(.media-video video) {
    max-width: 100%;
    border-radius: 0.4rem;
  }

  .surface :global(.note-image) {
    max-width: 100%;
    height: auto;
    vertical-align: middle;
  }

  .surface :global(table) {
    border-collapse: collapse;
    display: block;
    overflow-x: auto;
    max-width: 100%;
    margin: 1.25em 0;
  }

  .surface :global(th),
  .surface :global(td) {
    border: 1px solid var(--border);
    padding: 0.45rem 0.75rem;
    min-width: 7em;
    max-width: 24em;
    vertical-align: top;
  }

  .surface :global(li[data-checked]) {
    list-style: none;
    position: relative;
  }
  .surface :global(.task-checkbox) {
    position: absolute;
    right: calc(100% + 0.15rem);
    top: -1px;
    width: 32px;
    height: 32px;
    border: 0;
    border-radius: 0.25em;
    padding: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }
  .surface :global(.task-checkbox::before) {
    content: "";
    position: absolute;
    inset: 7px;
    border: 1.5px solid var(--muted);
    border-radius: 4px;
  }
  .surface :global(.task-checkbox[aria-checked="true"]::before) {
    background: var(--accent-fill);
    border-color: var(--accent-fill);
  }
  .surface :global(.task-checkbox[aria-checked="true"]::after) {
    content: "";
    position: absolute;
    left: 13px;
    top: 10px;
    width: 4px;
    height: 8px;
    border: solid var(--accent-text);
    border-width: 0 1.5px 1.5px 0;
    transform: rotate(45deg);
  }
  .surface :global(.list-item-content > p:first-child) {
    margin-top: 0;
  }
  .surface :global(.ProseMirror-search-match) {
    background: light-dark(#fff0a8, #625018);
  }
  .surface :global(.ProseMirror-active-search-match) {
    outline: 2px solid var(--accent);
  }

  .surface :global(.math-source),
  .surface :global(.html-source) {
    display: block;
    max-width: 100%;
    padding: 0.4rem 0.6rem;
    color: var(--fg);
    background: var(--sidebar);
    border: 1px solid var(--accent);
    border-radius: 0.4rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.9em;
    line-height: 1.5;
    outline: none;
  }

  .surface :global(textarea.math-source),
  .surface :global(textarea.html-source) {
    width: 100%;
    resize: vertical;
  }

  .surface :global(.ProseMirror-selectednode) {
    outline: 2px solid var(--accent);
    outline-offset: 3px;
    border-radius: 0.2rem;
  }

  .surface :global(.source-editing) {
    outline: none;
  }

  .surface :global(.source-editing:is(.math-inline, .html-inline)) {
    display: inline-block;
    max-width: 100%;
    vertical-align: middle;
  }

  .surface :global(.math-error) {
    color: #b00020;
  }

  .surface :global(.ProseMirror mark) {
    color: inherit;
    background: light-dark(#fff3a3, #5c4a12);
    border-radius: 0.15em;
    padding: 0 0.05em;
  }

  .surface :global(:is(.comment-inline, .comment-block)) {
    color: var(--muted);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.85em;
    opacity: 0.8;
    cursor: text;
  }
  .surface :global(.comment-block) {
    display: block;
    margin: 0.85em 0;
    white-space: pre-wrap;
  }
  .surface :global(.comment-source) {
    display: block;
    width: 100%;
    padding: 0.4rem 0.6rem;
    color: var(--fg);
    background: var(--sidebar);
    border: 1px solid var(--accent);
    border-radius: 0.4rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.9em;
    outline: none;
  }

  .surface :global(.callout) {
    --callout: var(--accent);
    margin: 1.2em 0;
    padding: 0.6rem 0.9rem;
    border-left: 3px solid var(--callout);
    border-radius: 0.4rem;
    background: color-mix(in srgb, var(--callout) 8%, transparent);
  }
  .surface
    :global(
      .callout:is([data-callout="warning"], [data-callout="caution"], [data-callout="attention"])
    ) {
    --callout: light-dark(#b8660b, #f0b060);
  }
  .surface
    :global(
      .callout:is(
        [data-callout="danger"],
        [data-callout="error"],
        [data-callout="bug"],
        [data-callout="failure"],
        [data-callout="fail"]
      )
    ) {
    --callout: var(--danger);
  }
  .surface
    :global(
      .callout:is(
        [data-callout="tip"],
        [data-callout="hint"],
        [data-callout="success"],
        [data-callout="check"],
        [data-callout="done"]
      )
    ) {
    --callout: light-dark(#1f7a4a, #6fd39c);
  }
  .surface
    :global(.callout:is([data-callout="quote"], [data-callout="cite"], [data-callout="example"])) {
    --callout: var(--muted);
  }
  .surface :global(.callout-header) {
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }
  .surface :global(.callout-title) {
    flex: 1 1 auto;
    min-width: 0;
    font: inherit;
    font-weight: 600;
    color: var(--callout);
    background: transparent;
    border: 0;
    padding: 0;
    outline: none;
  }
  .surface :global(.callout-title::placeholder) {
    color: var(--callout);
    opacity: 1;
  }
  .surface :global(.callout-fold) {
    width: 1.2rem;
    height: 1.2rem;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--callout);
    cursor: pointer;
  }
  .surface :global(.callout-fold::before) {
    content: "▾";
  }
  .surface :global(.callout.collapsed .callout-fold::before) {
    content: "▸";
  }
  .surface :global(.callout.collapsed > .callout-content) {
    display: none;
  }
  .surface :global(.callout-content > :first-child) {
    margin-top: 0.4em;
  }
  .surface :global(.callout-content > :last-child) {
    margin-bottom: 0;
  }

  .surface :global(.footnote-ref) {
    color: var(--accent);
    font-size: 0.75em;
    cursor: pointer;
  }
  .surface :global(.footnote-def) {
    position: relative;
    margin: 0.6em 0;
    padding-left: 2.2em;
    font-size: 0.92em;
    color: var(--muted);
  }
  .surface :global(.footnote-def::before) {
    content: "[" attr(data-footnote-def) "]";
    position: absolute;
    left: 0;
    top: 0.85em;
    line-height: inherit;
    color: var(--accent);
    font-size: 0.85em;
  }

  .surface :global(.mermaid-block) {
    margin: 1em 0;
  }
  .surface :global(.mermaid-preview) {
    display: flex;
    justify-content: center;
    overflow-x: auto;
    cursor: pointer;
  }
  .surface :global(.mermaid-preview.mermaid-error) {
    justify-content: flex-start;
    color: var(--danger);
    font-size: 0.85em;
  }
  .surface :global(.mermaid-block:not(.code-active) .mermaid-source) {
    display: none;
  }

  /* 阅读视图：隐藏注释，链接可单击打开，标注标题只读。 */
  .surface.reading :global(:is(.comment-inline, .comment-block)) {
    display: none;
  }
  .surface.reading :global(:is(.wiki-link, .ProseMirror a)) {
    cursor: pointer;
  }
  .surface.reading :global(.callout-title) {
    pointer-events: none;
  }
  .surface.reading :global(.mermaid-preview) {
    cursor: default;
  }
</style>
