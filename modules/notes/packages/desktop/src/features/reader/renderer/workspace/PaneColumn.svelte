<script lang="ts">
  /**
   * 单个可编辑分栏：独立滚动区，承载文档表面或欢迎页。
   *
   * 阅读栈的滚动捕获/恢复绑定本栏滚动区；焦点或点击落在哪一栏，
   * 哪一栏就成为活动栏（命令、侧栏打开与工具栏状态的目标）。
   * 本栏正在切换文件时只锁住自己，另一栏继续可编辑。
   */
  import { onMount, tick, type Snippet } from "svelte";
  import { revealOnChange } from "../motion";
  import PaneToolbar from "./PaneToolbar.svelte";
  import DocumentSurface from "./DocumentSurface.svelte";
  import HoverPreview from "../preview/HoverPreview.svelte";
  import type { MediaIo } from "../preview/media";
  import type { ReaderPane } from "./pane.svelte";
  import type { ReaderWorkspaceController } from "./state.svelte";
  import type { PaneControls } from "./pane-controls";
  import OutlineTree from "../navigation/OutlineTree.svelte";
  import type { ArticleAgentActions } from "../../shared/article-conversations";

  let {
    workspace,
    pane,
    mediaIo,
    narrowInert,
    hidden = false,
    onRename,
    registerControls,
    onShowTools,
    articleAgent,
  }: {
    /** 将本栏操作与目录交给工作区，注销后不保留过期编辑器引用。 */
    registerControls: (id: number, controls: PaneControls | null) => void;
    onShowTools: () => void;
    articleAgent?: ArticleAgentActions;
    hidden?: boolean;
    onRename: () => void;
    workspace: ReaderWorkspaceController;
    /** 本栏状态；实例存活期间不变（分栏列表按 id 键控）。 */
    pane: ReaderPane;
    mediaIo: MediaIo;
    /** 窄屏且文件栏展开时正文 inert。 */
    narrowInert: boolean;
  } = $props();

  let scrollElement: HTMLElement | undefined = $state();
  let paneElement: HTMLElement;
  let lastPosition: ReturnType<ReaderPane["navigation"]["capturePosition"]> = null;
  let positionEpoch = -1;
  let viewportWidth = 0;
  let viewportHeight = 0;
  function captureReading(): void {
    if (
      !scrollElement ||
      scrollElement.clientWidth !== viewportWidth ||
      scrollElement.clientHeight !== viewportHeight
    )
      return;
    lastPosition = pane.navigation.capturePosition();
    positionEpoch = doc.epoch;
    pane.navigation.updateOutlinePosition();
  }

  let toolbar = $state<Snippet | null>(null);

  // 工具内容仍归所属编辑器；分栏只负责为它分配独立于正文滚动区的空间。
  function registerToolbar(content: Snippet | null): void {
    toolbar = content;
  }
  const doc = $derived(pane.document);
  $effect(() => {
    const register = registerControls;
    register(pane.id, { toolbar: controls, outline });
    return () => register(pane.id, null);
  });

  onMount(() => {
    // 观察子控件的键盘意图而非给容器增加键盘动作；子控件阻止冒泡也应取消旧定位。
    const cancelRestore = () => pane.navigation.cancelPositionRestore();
    paneElement.addEventListener("keydown", cancelRestore, true);
    return () => paneElement.removeEventListener("keydown", cancelRestore, true);
  });

  onMount(() => {
    // 侧栏开合改变正文宽度时，恢复同一阅读锚点及其视口偏移。
    const updateLayout = () => {
      if (!scrollElement || scrollElement.clientWidth === 0) return;
      const changed =
        viewportWidth !== scrollElement.clientWidth ||
        viewportHeight !== scrollElement.clientHeight;
      viewportWidth = scrollElement.clientWidth;
      viewportHeight = scrollElement.clientHeight;
      if (changed && lastPosition !== null && positionEpoch === doc.epoch)
        void pane.navigation
          .restorePosition({ reading: lastPosition.reading, selection: null })
          .then(captureReading);
      else captureReading();
    };
    const observer = new ResizeObserver(updateLayout);
    observer.observe(paneElement);
    if (scrollElement) observer.observe(scrollElement);
    updateLayout();
    return () => observer.disconnect();
  });

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

{#snippet controls()}
  <PaneToolbar {workspace} {pane} {onRename} />
  {#if toolbar !== null}<div class="pane-tools">{@render toolbar()}</div>{/if}
{/snippet}

{#snippet outline()}
  {#if pane.navigation.hasOutline}
    <section class="outline-sidebar" aria-label="本文目录">
      <nav aria-label="文档目录">
        <OutlineTree
          nodes={pane.navigation.outlineTree}
          collapsed={pane.navigation.collapsedKeys}
          activeKey={pane.navigation.activeOutlineKey}
          onToggle={pane.navigation.toggleOutline}
          onJump={(pos) => pane.navigation.jumpOutline(pos)}
        />
      </nav>
    </section>
  {:else}
    {@const recent = workspace.recentFiles.filter((path) => path !== pane.document.path)}
    {#if recent.length > 0}
      <section class="outline-recent" aria-label="最近文件">
        <p class="recent-head">最近文件</p>
        <nav aria-label="最近文件列表">
          {#each recent.slice(0, 12) as path (path)}
            <button
              type="button"
              class="recent-entry"
              title={path}
              onclick={() => void workspace.openFile(path)}
            >
              <span class="recent-name">{path.split("/").at(-1)}</span>
              {#if path.includes("/")}<span class="recent-dir"
                  >{path.slice(0, path.lastIndexOf("/"))}</span
                >{/if}
            </button>
          {/each}
        </nav>
      </section>
    {:else}
      <p class="component-empty">当前文档没有标题，最近也没有打开过其他文件。</p>
    {/if}
  {/if}
{/snippet}

<section
  {hidden}
  bind:this={paneElement}
  class="pane-column"
  class:active={workspace.activePane.id === pane.id}
  role="group"
  tabindex="-1"
  aria-label={workspace.split ? `编辑分栏 ${pane.id + 1}` : "编辑区"}
  inert={narrowInert || pane.switching}
  data-pane={pane.id}
  onpointerdown={() => {
    pane.navigation.cancelPositionRestore();
    workspace.activatePane(pane.id);
  }}
  onfocusin={() => workspace.activatePane(pane.id)}
>
  <div class="pane-content">
    <div
      class="main"
      class:whiteboard-pane={doc.content?.kind === "whiteboard"}
      bind:this={scrollElement}
      onwheel={() => pane.navigation.cancelPositionRestore()}
      onscroll={captureReading}
      onscrollend={pane.rememberReadingPosition}
    >
      <div
        use:revealOnChange={{ key: JSON.stringify([doc.path, pane.viewMode]), kind: "document" }}
        class:document-body={doc.content?.kind === "markdown"}
        class:whiteboard-body={doc.content?.kind === "whiteboard"}
      >
        {#if doc.path !== null}
          <DocumentSurface
            {...articleAgent ? { articleAgent } : {}}
            {workspace}
            {pane}
            {mediaIo}
            {registerToolbar}
            {onShowTools}
          />
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
              <p class="local-storage">笔记保存在你选择的本机文件夹中。</p>
            {/if}
          </div>
        {/if}
      </div>
    </div>
  </div>
</section>

<style>
  .outline-sidebar {
    padding: 0.5rem 0.75rem;
    overflow: auto;
    font-size: 0.8rem;
  }
  .component-empty {
    padding: 0.75rem;
    color: var(--muted);
    font-size: 0.8rem;
  }
  .outline-recent {
    padding: 0.5rem 0.5rem 0.75rem;
    overflow: auto;
    min-height: 0;
  }
  .outline-recent nav {
    display: flex;
    flex-direction: column;
  }
  .recent-head {
    margin: 0.25rem 0.25rem 0.4rem;
    color: var(--muted);
    font-size: 0.75rem;
    font-weight: 600;
  }
  .recent-entry {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    width: 100%;
    padding: 0.35rem 0.4rem;
    border: 0;
    border-radius: var(--radius-control);
    background: transparent;
    color: var(--fg);
    font: inherit;
    font-size: 0.8rem;
    text-align: left;
    cursor: pointer;
  }
  .recent-entry:hover,
  .recent-entry:focus-visible {
    background: var(--selected);
    outline: none;
  }
  .recent-name {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .recent-dir {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    color: var(--muted);
    font-size: 0.7rem;
  }
  .pane-column[hidden] {
    display: none;
  }
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
  .pane-tools {
    flex: 0 0 auto;
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
  .welcome .local-storage {
    font-size: 0.75rem;
    margin-top: 1.25rem;
  }
</style>
