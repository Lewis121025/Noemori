<script lang="ts">
  /** 只读的选择预览；磁盘读取错误留在本面板，过期结果不能覆盖后来的选择。 */
  import type { VaultEntry } from "../../../shared/api";
  import { readFileContent, type FileContent } from "../../engine/document/file-content";
  import { libraryEntryKind, libraryExcerpt } from "../../engine/navigation/library";
  import ImagePreview from "../previews/ImagePreview.svelte";
  import PdfPreview from "../previews/PdfPreview.svelte";

  let {
    entry,
    entries,
    root,
    revision,
    readFile,
    onOpen,
    busy,
    selectionCount,
  }: {
    entry: VaultEntry | null;
    entries: readonly VaultEntry[];
    root: string | null;
    revision: number;
    readFile: (path: string) => Promise<Uint8Array>;
    onOpen: (entry: VaultEntry) => void;
    busy: boolean;
    selectionCount: number;
  } = $props();
  let content = $state.raw<FileContent | null>(null);
  let excerpt = $state<string[]>([]);
  let error = $state("");
  let loading = $state(false);
  const descendants = $derived(
    entry === null ? [] : entries.filter((item) => item.path.startsWith(`${entry.path}/`)),
  );

  $effect(() => {
    const selected = entry;
    void root;
    void revision;
    content = null;
    excerpt = [];
    error = "";
    loading = selected?.kind === "file";
    let cancelled = false;
    if (selected?.kind === "file") {
      void readFile(selected.path)
        .then((bytes) => {
          if (cancelled) return;
          const next = readFileContent(selected.path, bytes);
          if (next.kind === "markdown") excerpt = libraryExcerpt(next.source);
          content = next;
        })
        .catch((cause: unknown) => {
          if (!cancelled) error = cause instanceof Error ? cause.message : String(cause);
        })
        .finally(() => {
          if (!cancelled) loading = false;
        });
    }
    // 选择、库或索引变化后，旧读取不能把预览替换成另一份资料。
    return () => {
      cancelled = true;
    };
  });
</script>

<section class="library-preview" aria-label="资料预览">
  {#if entry === null}
    <div class="preview-empty">
      {#if selectionCount > 1}
        <p>已选择 {selectionCount} 项资料</p>
        <span>可一起移动或移到废纸篓。选择单项后查看预览。</span>
      {:else}
        <p>选一份资料，先看看内容。</p>
        <span>双击或按回车打开，按住 ⌘ / Ctrl 多选整理。</span>
      {/if}
    </div>
  {:else}
    <div class="preview-heading">
      <span class="kind">{libraryEntryKind(entry)}</span>
      <h2>{entry.path.split("/").at(-1)}</h2>
      <p class="path">{entry.path}</p>
      {#if entry.kind === "file"}<button
          class="reader-button primary"
          type="button"
          disabled={busy}
          onclick={() => onOpen(entry)}>打开阅读与写作</button
        >{/if}
    </div>
    {#if entry.kind === "directory"}
      <p class="folder-summary">
        包含 {descendants.filter((item) => item.kind === "file").length} 个文件、{descendants.filter(
          (item) => item.kind === "directory",
        ).length} 个文件夹。
      </p>
    {:else if loading}<p role="status">正在预览…</p>
    {:else if error}<p role="alert">无法预览：{error}</p>
    {:else if content?.kind === "image"}<ImagePreview path={entry.path} bytes={content.bytes} />
    {:else if content?.kind === "pdf"}<PdfPreview bytes={content.bytes} compact />
    {:else if content?.kind === "markdown"}
      <div class="excerpt">
        {#each excerpt as paragraph, index (index)}<p>
            {paragraph}
          </p>{/each}{#if excerpt.length === 0}<p class="kind">这篇笔记还没有正文。</p>{/if}
      </div>
    {:else if content?.kind === "text"}<pre>{content.source.slice(0, 6000)}</pre>
    {:else if content !== null}<p class="kind">
        此文件暂不支持内容预览，可在系统文件夹中打开。
      </p>{/if}
  {/if}
</section>

<style>
  .library-preview {
    padding: 1.5rem;
    min-width: 0;
    min-height: 0;
    overflow: auto;
    border-left: 1px solid var(--border);
    background: var(--bg);
  }
  .preview-empty {
    display: flex;
    flex-direction: column;
    justify-content: center;
    min-height: 15rem;
    color: var(--muted);
  }
  .preview-empty span,
  .kind,
  .path {
    font-size: 0.8rem;
    color: var(--muted);
  }
  h2 {
    font-size: 1.15rem;
    font-weight: 500;
    margin: 0.5rem 0;
    overflow-wrap: anywhere;
  }
  .path {
    overflow-wrap: anywhere;
    margin: 0 0 1rem;
  }
  .preview-heading {
    padding-bottom: 1.25rem;
  }
  .excerpt {
    line-height: 1.9;
    overflow-wrap: anywhere;
  }
  .excerpt p {
    white-space: pre-wrap;
    margin: 0 0 1rem;
  }
  pre {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-size: 0.85rem;
  }
  [role="alert"] {
    color: var(--danger);
  }
  @media (max-width: 720px) {
    .library-preview {
      border-left: 0;
      padding: 1rem;
    }
    .preview-empty {
      min-height: 0;
    }
  }
</style>
