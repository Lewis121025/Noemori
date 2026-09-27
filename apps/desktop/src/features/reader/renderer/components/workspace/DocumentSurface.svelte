<script lang="ts">
  import BacklinksPane from "../navigation/BacklinksPane.svelte";
  import OutlinksPane from "../navigation/OutlinksPane.svelte";
  import LocalGraphPane from "../graph/LocalGraphPane.svelte";
  import CodeEditor from "../editors/CodeEditor.svelte";
  import DocumentEditor from "../editors/DocumentEditor.svelte";
  import ImagePreview from "../previews/ImagePreview.svelte";
  import PdfPreview from "../previews/PdfPreview.svelte";
  import type { MediaIo } from "../../engine/media/media";
  import { markdownLinkCompletion } from "../../engine/editing/link-suggest/codemirror";
  import type { ReaderPane } from "../../state/pane.svelte";
  import type { ReaderWorkspaceController } from "../../state/workspace.svelte";

  let {
    workspace,
    pane,
    mediaIo,
  }: {
    workspace: ReaderWorkspaceController;
    /** 本栏文档面；文档、导航与链接动作都归属这一栏。 */
    pane: ReaderPane;
    mediaIo: MediaIo;
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
</script>

{#if doc.path !== null}
  {#key workspace.vaultRoot}
    {#key doc.path}
      {#if doc.content?.kind === "markdown" && pane.viewMode !== "source"}
        <DocumentEditor
          readOnly={pane.viewMode === "reading"}
          formattingId="editor-formatting-{pane.id}"
          active={workspace.activePane.id === pane.id}
          linkTargets={workspace.files.filter((path) => path.toLowerCase().endsWith(".md"))}
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
          source={doc.content.source}
          path={doc.path}
          onDirty={pane.markDirty}
          onSave={pane.requestSave}
          register={navigation.registerCode}
          {...doc.content.kind === "markdown" ? { completions: sourceCompletions } : {}}
        />
      {:else if doc.content?.kind === "image"}
        <ImagePreview path={doc.path} bytes={doc.content.bytes} />
      {:else if doc.content?.kind === "pdf"}
        <PdfPreview bytes={doc.content.bytes} />
      {:else}
        <section class="unsupported" aria-label="附件预览">
          <h2>暂不支持预览此文件</h2>
          <p>{doc.path}</p>
          <p>可预览图片、PDF 和 UTF-8 文本文件。</p>
        </section>
      {/if}
    {/key}
  {/key}

  {#key doc.epoch}
    <OutlinksPane
      links={navigation.outlinks}
      onOpen={(link) => void pane.openLink(link.kind, link.toRaw)}
    />
    <BacklinksPane
      mentions={navigation.mentions}
      onOpen={(mention) => void navigation.openMention(mention, pane.openFile)}
      onLinkify={(mention) => {
        const path = doc.path;
        if (path !== null) void pane.linkifyMention(mention, path);
      }}
    />
  {/key}
  {#if doc.content?.kind === "markdown"}
    <LocalGraphPane
      {workspace}
      path={doc.path}
      onOpen={(node) =>
        void (node.dead ? pane.openLink("wiki", node.path) : pane.openFile(node.path))}
    />
  {/if}
{/if}

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
