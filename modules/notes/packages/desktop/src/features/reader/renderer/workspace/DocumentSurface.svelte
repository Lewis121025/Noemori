<script lang="ts">
  import { type Snippet } from "svelte";
  import CodeEditor from "../editor/CodeEditor.svelte";
  import DocumentEditor from "../editor/DocumentEditor.svelte";
  import ImagePreview from "../preview/ImagePreview.svelte";
  import PdfPreview from "../preview/PdfPreview.svelte";
  import WhiteboardEditor from "../whiteboard/WhiteboardEditor.svelte";
  import { isWhiteboardPath } from "../../shared/whiteboard/model";
  import type { MediaIo } from "../preview/media";
  import { markdownLinkCompletion } from "../editor/links/suggestions/codemirror";
  import type { ReaderPane } from "./pane.svelte";
  import type { ReaderWorkspaceController } from "./state.svelte";
  import type {
    ArticleAgentActions,
    ArticleEditorActions,
  } from "../../shared/article-conversations";

  let {
    workspace,
    pane,
    mediaIo,
    registerToolbar,
    onShowTools,
    articleAgent,
  }: {
    workspace: ReaderWorkspaceController;
    /** 本栏文档面；文档、导航与链接动作都归属这一栏。 */
    pane: ReaderPane;
    mediaIo: MediaIo;
    /** 当前表面的工具由窗口顶栏呈现，卸载时撤下。 */
    registerToolbar: (toolbar: Snippet | null) => void;
    onShowTools: () => void;
    articleAgent?: ArticleAgentActions;
  } = $props();
  const doc = $derived(pane.document);
  const navigation = $derived(pane.navigation);
  // 源码视图的 [[ 补全；文件列表与别名在每次触发时实时读取，
  // 标题锚点与块经本栏解析目标后获取（与排版模式共用排序）。
  const sourceCompletions = markdownLinkCompletion(() => workspace.files, {
    headings: (target) => pane.suggestHeadings(target, "wiki"),
    aliases: () => workspace.noteKeys,
    blocks: (target) => pane.suggestBlocks(target, "wiki"),
    ensureBlockId: (path, block) => pane.ensureBlockId(path, block),
  });
  let editorTools = $state<Snippet | null>(null);
  const articleActions = $derived.by((): ArticleEditorActions | undefined => {
    const bridge = articleAgent,
      root = workspace.vaultRoot,
      path = doc.path;
    if (!bridge || !root || !path) return undefined;
    const preview: ArticleEditorActions["preview"] = async (id) => {
      await bridge.api.attachVault(root);
      return bridge.api.snapshot(id);
    };
    return {
      create: async (title) => {
        if (
          !(await pane.flushBeforeLeave()) ||
          root !== workspace.vaultRoot ||
          path !== pane.document.path
        )
          throw new Error("文章尚未保存或已经切换");
        return bridge.api.createArticle({ root, path, title });
      },
      discard: (id) => bridge.api.remove(id),
      preview,
      open: async (id) => {
        if (!(await pane.flushBeforeLeave())) throw new Error("请先处理文章保存问题");
        const item = await preview(id);
        // 独立对话的文中链接只提供导航来源，不把当前文章变成对话关联。
        await bridge.open(id, { root: item.workspace ?? root, path: item.article?.path ?? path });
      },
      report: (message) => workspace.report(message),
    };
  });
  function registerEditorTools(tools: Snippet | null): void {
    editorTools = tools;
  }
  $effect(() => {
    const register = registerToolbar;
    register(documentTools);
    return () => register(null);
  });
</script>

{#if doc.path !== null}
  {#key workspace.vaultRoot}
    {#key doc.path}
      {#if doc.content?.kind === "whiteboard"}
        <WhiteboardEditor
          registerToolbar={registerEditorTools}
          board={doc.content.board}
          epoch={doc.epoch}
          register={navigation.registerWhiteboard}
          onDirty={pane.markDirty}
          repair={workspace.repairWhiteboard}
        />
      {:else if doc.content?.kind === "markdown" && pane.viewMode !== "source"}
        <DocumentEditor
          {...articleActions ? { articleActions } : {}}
          {onShowTools}
          registerToolbar={registerEditorTools}
          epoch={doc.epoch}
          formattingId="editor-formatting-{pane.id}"
          linkTargets={workspace.files.filter(
            (path) => path.toLowerCase().endsWith(".md") || isWhiteboardPath(path),
          )}
          {mediaIo}
          importAttachment={pane.captureAttachmentImporter()}
          onAttachmentReport={(message) => workspace.report(message)}
          onAttachmentSettled={workspace.resumeExternalRefresh}
          path={doc.path}
          source={doc.content.source}
          recovery={doc.content.recovery}
          onDirty={pane.markDirty}
          onSave={pane.requestSave}
          onOpenLink={pane.openLink}
          onOutline={navigation.setOutline}
          register={navigation.registerMarkdown}
          suggestHeadings={pane.suggestHeadings}
          linkAliases={workspace.noteKeys}
          suggestBlocks={pane.suggestBlocks}
          ensureBlockId={pane.ensureBlockId}
        />
      {:else if doc.content?.kind === "markdown" || doc.content?.kind === "text"}
        <CodeEditor
          {onShowTools}
          registerToolbar={registerEditorTools}
          epoch={doc.epoch}
          source={doc.content.source}
          path={doc.path}
          onDirty={pane.markDirty}
          onSave={pane.requestSave}
          register={navigation.registerCode}
          {...doc.content.kind === "markdown" ? { completions: sourceCompletions } : {}}
        />
      {:else if doc.content?.kind === "image"}
        <ImagePreview
          path={doc.path}
          bytes={doc.content.bytes}
          registerToolbar={registerEditorTools}
        />
      {:else if doc.content?.kind === "pdf"}
        <PdfPreview bytes={doc.content.bytes} registerToolbar={registerEditorTools} />
      {:else}
        <section class="unsupported" aria-label="附件预览">
          <h2>暂不支持预览此文件</h2>
          <p>{doc.path}</p>
          <p>可预览图片、PDF 和 UTF-8 文本文件。</p>
        </section>
      {/if}
    {/key}
  {/key}
{/if}

{#snippet documentTools()}
  <div class="editor-tools">
    {#if editorTools}{@render editorTools()}{/if}
  </div>
{/snippet}

<style>
  .unsupported {
    padding: 3rem 1rem;
    text-align: center;
    overflow-wrap: anywhere;
  }
  h2 {
    font-size: 1rem;
    font-weight: 500;
    margin: 0 0 1rem;
  }
</style>
