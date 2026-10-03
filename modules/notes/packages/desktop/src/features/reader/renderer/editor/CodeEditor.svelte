<script lang="ts">
  /**
   * 可编辑代码表面：CodeMirror 6 挂载一次，文本即文件。
   */
  import { untrack, type Snippet } from "svelte";
  import {
    defaultKeymap,
    history,
    historyKeymap,
    indentWithTab,
    redo,
    redoDepth,
    undo,
    undoDepth,
  } from "@codemirror/commands";
  import {
    bracketMatching,
    defaultHighlightStyle,
    indentOnInput,
    syntaxHighlighting,
  } from "@codemirror/language";
  import { EditorState, Compartment, EditorSelection, type Extension } from "@codemirror/state";
  import { EditorView, keymap, lineNumbers } from "@codemirror/view";
  import { openSearchPanel, search, searchKeymap } from "@codemirror/search";
  import type { CodeEditorApi } from "./editor-api";
  import { languageExtensions } from "./language";
  import { utf8ByteToCodeIndex } from "../document/source-offset";
  import { applyCodeChanges } from "./source/code-source";
  import { nativeInputOwnsHistory } from "./history";
  import { bindCodeSearchInput } from "./search/code-search";
  import { codePosition } from "./editor-position";
  import {
    captureCodeReload,
    prepareCodeReload,
    type CodeReloadContext,
  } from "./source/code-reload";

  type Props = {
    /** 文档加载代次；文本相同的重载只重新登记表面归属。 */
    epoch?: number;
    /** 阅读模式可修改文本，但不显示编辑工具栏。 */
    reading?: boolean;
    /** 将工具栏交给分栏独立排版；独立挂载时使用普通文档流。 */
    registerToolbar?: (toolbar: Snippet | null) => void;
    /** 打开时的文本。 */
    source: string;
    /** 用于选择高亮语言的库内路径。 */
    path: string;
    /** 缓冲被改动时调用。 */
    onDirty: () => void;
    /** 保存快捷键。 */
    onSave: () => void;
    /** 注册/注销取文本入口。 */
    register: (api: CodeEditorApi | null) => void;
    /** 额外编辑扩展；Markdown 源码视图用于 `[[` 链接补全。 */
    completions?: Extension;
  };

  let {
    source,
    path,
    onDirty,
    onSave,
    register,
    completions,
    epoch = 0,
    reading = false,
    registerToolbar,
  }: Props = $props();
  $effect(() => {
    const register = registerToolbar;
    if (register === undefined) return;
    register(reading ? null : editorToolbar);
    return () => register(null);
  });
  let host: HTMLDivElement | undefined = $state();
  let editorState = $state.raw<EditorState | null>(null);
  let publicApi = $state.raw<CodeEditorApi | null>(null);
  let previous: CodeReloadContext | null = null;

  $effect(() => {
    const el = host;
    if (el === undefined) {
      return;
    }
    const currentPath = path;
    const currentSource = source;
    // 先记下 path/source。挂载里调用的 onDirty 可能读外壳状态，不能进依赖。
    return untrack(() => {
      const save = onSave;
      const dirty = onDirty;
      let cancelled = false;
      let revision = 0;
      let rawSource = currentSource;
      const reload = previous === null ? null : prepareCodeReload(previous, currentSource);
      previous = null;
      const langConf = new Compartment();
      const view = new EditorView({
        parent: el,
        state: EditorState.create({
          doc: reload?.doc ?? currentSource,
          ...(reload === null ? {} : { selection: reload.selection }),
          extensions: [
            history(),
            search({ top: true }),
            EditorState.phrases.of({
              Find: "查找",
              Replace: "替换为",
              next: "下一处",
              previous: "上一处",
              all: "选择全部",
              "match case": "区分大小写",
              regexp: "正则表达式",
              "by word": "全词匹配",
              replace: "替换",
              "replace all": "全部替换",
              close: "关闭查找",
              "Go to line": "跳转到行",
              go: "跳转",
              "current match": "当前匹配",
              "on line": "所在行",
              "replaced match on line $": "已替换第 $ 行的匹配",
              "replaced $ matches": "已替换 $ 处匹配",
            }),
            keymap.of([
              {
                key: "Mod-s",
                run: () => {
                  save();
                  return true;
                },
              },
              indentWithTab,
              ...searchKeymap,
              ...defaultKeymap,
              ...historyKeymap,
            ]),
            lineNumbers(),
            indentOnInput(),
            bracketMatching(),
            syntaxHighlighting(defaultHighlightStyle),
            EditorView.updateListener.of((update) => {
              editorState = update.state;
              if (update.docChanged) {
                for (const transaction of update.transactions) {
                  if (!transaction.docChanged) continue;
                  rawSource = applyCodeChanges(rawSource, transaction.changes);
                  revision += 1;
                }
                dirty();
              }
            }),
            EditorView.theme({
              "&": {
                height: "100%",
                backgroundColor: "var(--bg)",
                color: "var(--fg)",
              },
              ".cm-scroller": {
                fontFamily: "var(--font-code)",
                fontSize: "14px",
                lineHeight: "1.7",
                fontVariantLigatures: "none",
              },
              ".cm-gutters": {
                color: "var(--muted)",
                backgroundColor: "var(--chrome)",
                borderColor: "var(--border)",
              },
            }),
            langConf.of([]),
            ...(completions === undefined ? [] : [completions]),
          ],
        }),
      });
      const stopSearchInput = bindCodeSearchInput(view);
      reload?.restore(view);
      editorState = view.state;
      const snapshot = () => ({ bytes: new TextEncoder().encode(rawSource), revision });
      publicApi = {
        ...codePosition(view, snapshot),
        history: (action) => {
          if (nativeInputOwnsHistory(view.contentDOM)) return false;
          if (!view.composing) (action === "undo" ? undo : redo)(view);
          return true;
        },
        historyAvailability: () => {
          if (nativeInputOwnsHistory(view.contentDOM)) return null;
          const state = editorState;
          return {
            undo: state !== null && undoDepth(state) > 0,
            redo: state !== null && redoDepth(state) > 0,
          };
        },
        focus: () => view.focus(),
        openSearch: () => {
          openSearchPanel(view);
        },
        snapshot,
        jumpToSearch: (location, snapshot) => {
          if (snapshot.revision !== revision) throw new Error("搜索结果已过期，请重新搜索后定位。");
          view.dispatch({
            selection: EditorSelection.range(
              utf8ByteToCodeIndex(rawSource, location.startByte),
              utf8ByteToCodeIndex(rawSource, location.endByte),
            ),
            scrollIntoView: true,
          });
          view.focus();
        },
        jumpToByte: (byteOffset) => {
          const index = Math.min(view.state.doc.length, utf8ByteToCodeIndex(rawSource, byteOffset));
          view.dispatch({
            selection: EditorSelection.cursor(index),
            scrollIntoView: true,
          });
          view.focus();
        },
      };
      void languageExtensions(currentPath).then((lang) => {
        if (cancelled) {
          return;
        }
        view.dispatch({ effects: langConf.reconfigure(lang) });
      });
      return () => {
        stopSearchInput();
        previous = captureCodeReload(view);
        cancelled = true;
        publicApi = null;
        editorState = null;
        view.destroy();
      };
    });
  });

  // 归属更新与文本会话分开：相同内容的重载不能重建编辑器并清空历史。
  $effect(() => {
    const api = publicApi;
    const bindApi = register;
    void epoch;
    if (api === null) return;
    return untrack(() => {
      bindApi(api);
      return () => bindApi(null);
    });
  });
</script>

{#snippet editorToolbar()}
  {#if !reading}
    <div
      class="code-toolbar"
      role="toolbar"
      aria-label="文本编辑工具栏"
      tabindex="-1"
      onmousedown={(event) => event.preventDefault()}
    >
      <button
        type="button"
        class="reader-button"
        disabled={editorState === null || undoDepth(editorState) === 0}
        onclick={() => publicApi?.history("undo")}>撤销</button
      >
      <button
        type="button"
        class="reader-button"
        disabled={editorState === null || redoDepth(editorState) === 0}
        onclick={() => publicApi?.history("redo")}>重做</button
      >
      <button type="button" class="reader-button" onclick={() => publicApi?.openSearch()}
        >查找</button
      >
    </div>
  {/if}
{/snippet}
{#if registerToolbar === undefined}{@render editorToolbar()}{/if}
<div class="surface" bind:this={host}></div>

<style>
  .code-toolbar {
    display: flex;
    gap: 0.3rem;
    background: var(--bg);
    border-bottom: 1px solid var(--border);
    padding: 0.5rem;
    margin: 0;
  }
  .code-toolbar button {
    font-size: 0.8rem;
    border-color: transparent;
  }

  .surface {
    min-height: 16rem;
  }
</style>
