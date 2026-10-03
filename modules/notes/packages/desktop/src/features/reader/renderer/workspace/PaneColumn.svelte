<script lang="ts">
  /**
   * 单个可编辑分栏：独立滚动区，承载文档表面或欢迎页。
   *
   * 阅读栈的滚动捕获/恢复绑定本栏滚动区；焦点或点击落在哪一栏，
   * 哪一栏就成为活动栏（命令、侧栏打开与工具栏状态的目标）。
   * 本栏正在切换文件时只锁住自己，另一栏继续可编辑。
   */
  import { onMount, tick, type Snippet } from "svelte";
  import DocumentSurface from "./DocumentSurface.svelte";
  import HoverPreview from "../preview/HoverPreview.svelte";
  import OutlineTree from "../navigation/OutlineTree.svelte";
  import type { MediaIo } from "../preview/media";
  import type { ReaderPane } from "./pane.svelte";
  import type { ReaderWorkspaceController } from "./state.svelte";

  let {
    workspace,
    pane,
    mediaIo,
    narrowInert,
    filesCollapsed,
    onToggleFiles,
    onNewNote,
    onOpenVault,
  }: {
    workspace: ReaderWorkspaceController;
    /** 本栏状态；实例存活期间不变（分栏列表按 id 键控）。 */
    pane: ReaderPane;
    mediaIo: MediaIo;
    /** 窄屏且文件栏展开时正文 inert。 */
    narrowInert: boolean;
    filesCollapsed: boolean;
    onToggleFiles: () => void;
    onNewNote: () => void;
    onOpenVault: () => void;
  } = $props();

  let scrollElement: HTMLElement | undefined = $state();
  let toolbar = $state<Snippet | null>(null);

  // 工具内容仍归所属编辑器；分栏只负责为它分配独立于正文滚动区的空间。
  function registerToolbar(content: Snippet | null): void {
    toolbar = content;
  }
  const doc = $derived(pane.document);
  // 单个标题没有章节导航价值，短笔记不为目录预留一整栏。
  const hasOutline = $derived(
    pane.viewMode !== "source" &&
      pane.navigation.hasOutline &&
      (pane.navigation.outlineTree.length > 1 ||
        pane.navigation.outlineTree.some((node) => node.children.length > 0)),
  );

  onMount(() => {
    // 阅读栈的滚动捕获/恢复绑定到本栏滚动区；恢复等待新文档渲染完成，
    // 避免滚动值先被旧内容高度钳制。
    return pane.history.attachScroll({
      capture: () => scrollElement?.scrollTop ?? null,
      reset: () => {
        if (scrollElement) scrollElement.scrollTop = 0;
      },
      apply: async (top) => {
        const epoch = doc.epoch;
        await tick();
        if (scrollElement?.isConnected && doc.epoch === epoch) scrollElement.scrollTop = top;
      },
    });
  });
</script>

<section
  class="pane-column"
  class:active={workspace.activePane.id === pane.id}
  role="group"
  tabindex="-1"
  aria-label={workspace.split ? `编辑分栏 ${pane.id + 1}` : "编辑区"}
  inert={narrowInert || pane.switching}
  data-pane={pane.id}
  onpointerdown={() => workspace.activatePane(pane.id)}
  onfocusin={() => workspace.activatePane(pane.id)}
>
  <div class="pane-content">
    {#if toolbar !== null || workspace.split}
      <div class="pane-header">
        <div class="pane-tools">
          {#if toolbar !== null}{@render toolbar()}{/if}
        </div>
        {#if workspace.split}
          <button
            type="button"
            class="pane-close"
            aria-label="关闭此分栏"
            title="关闭此分栏"
            onclick={() => void workspace.closePane(pane.id)}>×</button
          >
        {/if}
      </div>
    {/if}
    <div
      class="main"
      class:whiteboard-pane={doc.content?.kind === "whiteboard"}
      bind:this={scrollElement}
      onscrollend={pane.rememberReadingPosition}
    >
      <div
        class:document-body={doc.content?.kind === "markdown"}
        class:whiteboard-body={doc.content?.kind === "whiteboard"}
      >
        {#if doc.path !== null}
          <DocumentSurface {workspace} {pane} {mediaIo} {registerToolbar} />
          {#if scrollElement !== undefined}
            <HoverPreview
              host={scrollElement}
              from={doc.path}
              io={mediaIo}
              openLink={pane.openLink}
            />
          {/if}
        {:else}
          <div class="welcome">
            <h1>
              {workspace.vaultRoot === null
                ? "你的笔记，安静地在这里。"
                : workspace.files.length === 0
                  ? "从第一篇笔记开始"
                  : workspace.split
                    ? "再打开一篇笔记"
                    : "留一点空间，给新的想法。"}
            </h1>
            <p>
              {workspace.vaultRoot === null
                ? "写下此刻的想法，或打开已有的资料。"
                : workspace.files.length === 0
                  ? "创建笔记后，就可以直接开始写作。"
                  : workspace.split
                    ? "从文件栏选择笔记，就会打开在这一栏。"
                    : "打开已有笔记，或写下此刻的想法。"}
            </p>
            {#if workspace.vaultRoot === null}
              <div class="welcome-actions">
                <button
                  type="button"
                  class="reader-button primary"
                  onclick={onNewNote}
                  disabled={workspace.switching}>开始记录</button
                >
                <button
                  type="button"
                  class="reader-button"
                  onclick={onOpenVault}
                  disabled={workspace.switching}>打开已有资料…</button
                >
              </div>
              <p class="local-storage">笔记保存在本机的“文稿 / Noemori”文件夹。</p>
            {:else}
              <div class="welcome-actions">
                <button
                  class="reader-button primary"
                  type="button"
                  onclick={onNewNote}
                  disabled={workspace.switching}>新建笔记</button
                >
                {#if filesCollapsed}
                  <button class="reader-button" type="button" onclick={onToggleFiles}
                    >显示文件栏</button
                  >
                {/if}
              </div>
            {/if}
          </div>
        {/if}
      </div>
    </div>
  </div>
  {#if hasOutline}
    <aside class="outline-sidebar" id="outline-sidebar-{pane.id}" aria-label="本文目录">
      <h2>本文目录</h2>
      <nav aria-label="文档目录">
        <OutlineTree
          nodes={pane.navigation.outlineTree}
          collapsed={pane.navigation.collapsedKeys}
          onToggle={pane.navigation.toggleOutline}
          onJump={(pos) => pane.navigation.jumpOutline(pos)}
        />
      </nav>
    </aside>
  {/if}
</section>

<style>
  .pane-column {
    container: reader-pane / inline-size;
    position: relative;
    display: flex;
    flex: 1 1 0;
    min-width: 0;
    min-height: 0;
  }
  .pane-content {
    display: flex;
    flex-direction: column;
    flex: 1 1 0;
    min-width: 0;
    min-height: 0;
  }
  .pane-header {
    display: flex;
    align-items: flex-start;
    flex: 0 0 auto;
    min-width: 0;
    background: var(--bg);
  }
  .pane-tools {
    flex: 1;
    min-width: 0;
  }
  .main.whiteboard-pane {
    padding: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .whiteboard-body {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .pane-column:focus {
    outline: none;
  }
  .main {
    /* 查找栏复用滚动区内边距，吸顶时对齐真实视口边缘。 */
    --reader-inset: clamp(1rem, 3cqi, 2.5rem);
    position: relative;
    flex: 1 1 0;
    overflow: auto;
    min-width: 0;
    min-height: 0;
    padding: var(--reader-inset);
  }
  /* 分栏之间的视觉分隔由外壳统一渲染（跨组件实例的相邻选择器）。 */
  .pane-close {
    flex: 0 0 auto;
    margin: 0.5rem;
    width: 1.6rem;
    height: 1.6rem;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--border);
    border-radius: 0.4rem;
    background: var(--bg);
    color: var(--muted);
    font-size: 0.9rem;
    line-height: 1;
    cursor: pointer;
  }
  .pane-close:hover {
    color: var(--fg);
    border-color: var(--muted);
  }
  .document-body {
    max-width: var(--reading-width);
    min-width: 0;
    margin: 0 auto;
    padding: 0.5rem 0 3rem;
  }
  .document-body :global(.surface > .markdown-content > table > tbody) {
    display: table;
    width: 100%;
  }
  .outline-sidebar {
    display: none;
    flex: 0 0 13rem;
    min-height: 0;
    min-width: 0;
    padding: 1.75rem 1rem 1rem;
    border-left: 1px solid color-mix(in srgb, var(--border) 55%, transparent);
    color: var(--muted);
  }
  .outline-sidebar h2 {
    margin: 0 0 0.85rem;
    padding-inline: 0.3rem;
    font-size: 0.75rem;
    font-weight: 500;
  }
  .outline-sidebar nav {
    min-height: 0;
    overflow: auto;
    overscroll-behavior: contain;
    font-size: 0.8rem;
    padding: 0.2rem;
  }
  .welcome {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 60vh;
    padding: 3rem 1.5rem;
    text-align: center;
  }
  .welcome h1 {
    font-family: var(--font-document);
    font-size: clamp(1.5rem, 2.6cqi, 2rem);
    font-weight: 500;
    line-height: 1.4;
  }
  .welcome p {
    color: var(--muted);
    margin: 0 0 1.5rem;
  }
  .welcome-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 0.65rem;
  }
  .welcome .local-storage {
    font-size: 0.75rem;
    margin-top: 1.25rem;
  }
  @container reader-pane (min-width: 64rem) {
    .outline-sidebar {
      display: flex;
      flex-direction: column;
    }
  }
</style>
