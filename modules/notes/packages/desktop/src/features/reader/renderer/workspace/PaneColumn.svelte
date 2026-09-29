<script lang="ts">
  /**
   * 单个可编辑分栏：独立滚动区，承载文档表面或欢迎页。
   *
   * 阅读栈的滚动捕获/恢复绑定本栏滚动区；焦点或点击落在哪一栏，
   * 哪一栏就成为活动栏（命令、侧栏打开与工具栏状态的目标）。
   * 本栏正在切换文件时只锁住自己，另一栏继续可编辑。
   */
  import { onMount, tick } from "svelte";
  import DocumentSurface from "./DocumentSurface.svelte";
  import HoverPreview from "../preview/HoverPreview.svelte";
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
  const doc = $derived(pane.document);

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
  class="main"
  class:whiteboard-pane={doc.content?.kind === "whiteboard"}
  class:active={workspace.activePane.id === pane.id}
  role="group"
  tabindex="-1"
  aria-label={workspace.split ? `编辑分栏 ${pane.id + 1}` : "编辑区"}
  bind:this={scrollElement}
  inert={narrowInert || pane.switching}
  data-pane={pane.id}
  onpointerdown={() => workspace.activatePane(pane.id)}
  onfocusin={() => workspace.activatePane(pane.id)}
  onscrollend={pane.rememberReadingPosition}
>
  {#if workspace.split}
    <button
      type="button"
      class="pane-close"
      aria-label="关闭此分栏"
      title="关闭此分栏"
      onclick={() => void workspace.closePane(pane.id)}>×</button
    >
  {/if}
  <div
    class:document-body={doc.content?.kind === "markdown"}
    class:whiteboard-body={doc.content?.kind === "whiteboard"}
  >
    {#if doc.path !== null}
      <DocumentSurface {workspace} {pane} {mediaIo} />
      {#if scrollElement !== undefined}
        <HoverPreview host={scrollElement} from={doc.path} io={mediaIo} openLink={pane.openLink} />
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
          <p class="local-storage">笔记保存在本机的“文稿 / Nous”文件夹。</p>
        {:else}
          <div class="welcome-actions">
            <button
              class="reader-button primary"
              type="button"
              onclick={onNewNote}
              disabled={workspace.switching}>新建笔记</button
            >
            {#if filesCollapsed}
              <button class="reader-button" type="button" onclick={onToggleFiles}>显示文件栏</button
              >
            {/if}
          </div>
        {/if}
      </div>
    {/if}
  </div>
</section>

<style>
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
  .main:focus {
    outline: none;
  }
  .main {
    /* 查找栏复用滚动区内边距，吸顶时对齐真实视口边缘。 */
    --reader-inset: clamp(1.5rem, 4vw, 3.5rem);
    position: relative;
    flex: 1 1 0;
    overflow: auto;
    min-width: 0;
    min-height: 0;
    padding: var(--reader-inset);
  }
  /* 分栏之间的视觉分隔由外壳统一渲染（跨组件实例的相邻选择器）。 */
  .pane-close {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    z-index: 2;
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
    margin: 0 auto;
    padding: 0.5rem 0 4rem;
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
    font-size: clamp(1.5rem, 2.6vw, 2rem);
    font-weight: 500;
    letter-spacing: -0.04em;
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
  @media (max-width: 640px) {
    .main {
      --reader-inset: 1rem;
    }
  }
</style>
