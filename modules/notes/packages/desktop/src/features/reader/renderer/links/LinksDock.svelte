<script lang="ts">
  import { revealOnChange } from "../motion";
  import { selectionIndicator } from "../selection-indicator";
  import { onMount } from "svelte";
  import BacklinksPane from "./BacklinksPane.svelte";
  import OutlinksPane from "./OutlinksPane.svelte";
  import { presentOutlinks } from "./outlinks";
  import type { ReaderWorkspaceController } from "../workspace/state.svelte";
  import type { MentionRecord, LinkRecord } from "../../shared/api";
  let {
    workspace,
    enabled,
    compact = false,
    onMention,
    onLink,
    onOpenSettings,
  }: {
    workspace: ReaderWorkspaceController;
    enabled: boolean;
    /** 文件管理窄栏只保留设置入口。 */
    compact?: boolean;
    onMention: (mention: MentionRecord) => void;
    onLink: (link: LinkRecord) => void;
    onOpenSettings: () => void;
  } = $props();
  const pane = $derived(workspace.activePane);
  const navigation = $derived(pane.navigation);
  // 自引用统一放在内部跳转区；入链只表示其他文件指向当前笔记。
  const linkedMentions = $derived(
    navigation.mentions.linked.filter((item) => item.fromPath !== pane.document.path),
  );
  const incoming = $derived(new Set(linkedMentions.map((item) => item.fromPath)).size);
  const unlinked = $derived(
    new Set(navigation.mentions.unlinked.map((item) => item.fromPath)).size,
  );
  const outgoingGroups = $derived(presentOutlinks(navigation.outlinks));
  const outgoing = $derived(
    outgoingGroups.resolved.length + outgoingGroups.ambiguous.length + outgoingGroups.dead.length,
  );
  let expanded = $state(false);
  let preferredSection = $state<"incoming" | "outgoing" | "unlinked" | null>(null);
  const section = $derived(
    preferredSection ??
      (incoming > 0
        ? "incoming"
        : outgoing > 0 || outgoingGroups.self.length > 0
          ? "outgoing"
          : unlinked > 0
            ? "unlinked"
            : "incoming"),
  );
  const id = $props.id();
  let dock: HTMLElement;
  let actions: HTMLDivElement;
  let handle: HTMLDivElement;
  let preferredHeight = $state<number | null>(null);
  let viewportHeight = $state(window.innerHeight);
  let maximumHeight = $state(480);
  const minimumHeight = $derived(Math.min(160, maximumHeight));
  let resize = $state<{
    pointerId: number;
    startY: number;
    startHeight: number;
    height: number;
  } | null>(null);
  const defaultHeight = $derived(Math.min(viewportHeight * 0.38, 384));
  const height = $derived(clampHeight(resize?.height ?? preferredHeight ?? defaultHeight));

  function clampHeight(value: number): number {
    return Math.min(maximumHeight, Math.max(minimumHeight, Math.round(value)));
  }
  onMount(() => {
    const parent = dock.parentElement;
    if (!parent) return;
    const components = parent.querySelector<HTMLElement>(".component-bar");
    const measure = () => {
      // 收起侧栏时没有可用几何，不覆盖用户尺寸；展开后继续按当前侧栏限制高度。
      if (parent.clientHeight === 0) return;
      viewportHeight = window.innerHeight;
      maximumHeight = Math.max(
        0,
        parent.clientHeight - (components?.offsetHeight ?? 0) - actions.offsetHeight - 160,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    observer.observe(actions);
    if (components) observer.observe(components);
    return () => observer.disconnect();
  });
  $effect(() => {
    if ((!expanded || !enabled) && resize !== null) cancelResize();
  });
  function cancelResize(): void {
    const pointerId = resize?.pointerId;
    resize = null;
    if (pointerId !== undefined && handle.hasPointerCapture(pointerId))
      handle.releasePointerCapture(pointerId);
  }
  function pointerDown(event: PointerEvent): void {
    if (event.button !== 0 || !expanded || !enabled || resize !== null) return;
    event.preventDefault();
    handle.focus({ preventScroll: true });
    resize = { pointerId: event.pointerId, startY: event.clientY, startHeight: height, height };
    handle.setPointerCapture(event.pointerId);
  }
  function pointerMove(event: PointerEvent): void {
    if (resize?.pointerId !== event.pointerId) return;
    resize.height = clampHeight(resize.startHeight + resize.startY - event.clientY);
  }
  function pointerUp(event: PointerEvent): void {
    if (resize?.pointerId !== event.pointerId) return;
    preferredHeight = height;
    resize = null;
    handle.releasePointerCapture(event.pointerId);
  }
  function resizeKey(event: KeyboardEvent): void {
    if (event.isComposing) return;
    if (event.key === "Escape" && resize !== null) {
      event.preventDefault();
      event.stopPropagation();
      cancelResize();
      return;
    }
    if (resize !== null) return;
    const step = event.shiftKey ? 48 : 16;
    const next =
      event.key === "ArrowUp"
        ? height + step
        : event.key === "ArrowDown"
          ? height - step
          : event.key === "Home"
            ? minimumHeight
            : event.key === "End"
              ? maximumHeight
              : null;
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    preferredHeight = clampHeight(next);
  }
</script>

{#snippet directionIcon(inward: boolean)}
  <svg class="direction-icon" viewBox="0 0 24 16" aria-hidden="true">
    {#if inward}<path d="M2 8h13m-4-4 4 4-4 4" /><circle cx="20" cy="8" r="2" />
    {:else}<circle cx="4" cy="8" r="2" /><path d="M8 8h13m-4-4 4 4-4 4" />{/if}
  </svg>
{/snippet}

<footer class="links-dock" class:compact bind:this={dock}>
  <div class="dock-actions" bind:this={actions}>
    <button
      class="dock-toggle"
      hidden={compact}
      type="button"
      aria-label="双链"
      title={`双链 · ${incoming} 条入链 · ${outgoing} 条出链`}
      aria-expanded={expanded}
      aria-controls={id}
      disabled={!enabled || pane.document.path === null}
      onclick={() => (expanded = !expanded)}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true"
        ><path
          d="m10 13 4-4M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M13 8l1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0"
        /></svg
      >
      <span class="dock-title">双链</span>
      {#if !expanded}<span class="dock-count"
          ><span>{incoming} 入链</span><span>·</span><span>{outgoing} 出链</span></span
        >{/if}
      <span class="chevron" aria-hidden="true">⌃</span>
    </button>
    <button
      class="reader-button icon-button"
      type="button"
      aria-label="设置"
      title="设置（⌘/Ctrl+,）"
      onclick={onOpenSettings}
    >
      <svg class="reader-icon" viewBox="0 0 24 24" aria-hidden="true"
        ><path d="M4 7h16M4 17h16M9 4v6M15 14v6" /></svg
      >
    </button>
  </div>
  <section
    {id}
    class="dock-panel"
    style:--dock-height="{height}px"
    class:resizing={resize !== null}
    hidden={!expanded || !enabled}
    inert={!expanded || !enabled}
    aria-label="双链面板"
  >
    <!-- 带尺寸范围的分隔条按 WAI-ARIA 支持键盘调整，不能只依赖鼠标拖动。 -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
    <div
      bind:this={handle}
      class="height-resize"
      class:resizing={resize !== null}
      role="separator"
      tabindex="0"
      aria-label="调整双链高度"
      aria-controls={id}
      aria-orientation="horizontal"
      aria-valuemin={minimumHeight}
      aria-valuemax={maximumHeight}
      aria-valuenow={height}
      title="上下拖动调整高度，双击恢复默认；也可使用上下方向键"
      onpointerdown={pointerDown}
      onpointermove={pointerMove}
      onpointerup={pointerUp}
      onpointercancel={(event) => {
        if (resize?.pointerId === event.pointerId) cancelResize();
      }}
      onlostpointercapture={(event) => {
        if (resize?.pointerId === event.pointerId) resize = null;
      }}
      onkeydown={resizeKey}
      ondblclick={() => {
        preferredHeight = null;
      }}
    ></div>
    <div class="relation-tabs" role="group" aria-label="双链类别" use:selectionIndicator={section}>
      <button
        type="button"
        aria-label="入链"
        title={`入链：其他笔记 → 当前笔记 · ${incoming} 个来源`}
        aria-pressed={section === "incoming"}
        onclick={() => (preferredSection = "incoming")}
        >{@render directionIcon(true)}<span>{incoming}</span></button
      >
      <button
        type="button"
        aria-label="出链"
        title={`出链：当前笔记 → 其他目标 · ${outgoing} 个目标`}
        aria-pressed={section === "outgoing"}
        onclick={() => (preferredSection = "outgoing")}
        >{@render directionIcon(false)}<span>{outgoing}</span></button
      >
      <button
        type="button"
        aria-label="提及"
        title={`未链接提及 · ${unlinked} 篇笔记`}
        aria-pressed={section === "unlinked"}
        onclick={() => (preferredSection = "unlinked")}
        ><span class="tab-symbol" aria-hidden="true">@</span><span>{unlinked}</span></button
      >
    </div>
    <div class="relation-list" use:revealOnChange={{ key: section, kind: "panel" }}>
      {#if section === "outgoing"}
        <OutlinksPane groups={outgoingGroups} onOpen={onLink} />
        {#if navigation.outlinks.length === 0}<p
            class="empty"
            role="status"
            aria-label="暂无出链"
            title="暂无出链"
          >
            —
          </p>{/if}
      {:else}
        <BacklinksPane
          mentions={{
            linked: section === "incoming" ? linkedMentions : [],
            unlinked: section === "unlinked" ? navigation.mentions.unlinked : [],
          }}
          onOpen={onMention}
          onLinkify={(mention) => {
            const path = pane.document.path;
            if (path) void pane.linkifyMention(mention, path);
          }}
        />
        {#if (section === "incoming" ? incoming : unlinked) === 0}<p
            class="empty"
            role="status"
            aria-label={section === "incoming" ? "暂无入链" : "暂无未链接提及"}
            title={section === "incoming" ? "暂无入链" : "暂无未链接提及"}
          >
            —
          </p>{/if}
      {/if}
    </div>
  </section>
</footer>

<style>
  .links-dock {
    container-type: inline-size;
    display: flex;
    flex-direction: column;
    flex: 0 0 auto;
    min-height: 0;
    border-top: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
    background: transparent;
    margin-top: auto;
  }
  .dock-actions {
    order: 2;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 5px 10px;
  }
  .dock-toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    min-width: 0;
    min-height: 34px;
    border: 0;
    border-radius: 7px;
    padding: 5px;
    color: var(--muted);
    background: transparent;
    font: inherit;
    text-align: left;
    cursor: pointer;
    white-space: nowrap;
  }
  .dock-toggle[hidden] {
    display: none;
  }
  .compact .dock-actions {
    padding: 6px;
    justify-content: center;
  }
  .dock-toggle:hover:not(:disabled),
  .dock-toggle[aria-expanded="true"] {
    background: var(--selected);
  }
  .dock-toggle:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .dock-toggle svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    flex-shrink: 0;
  }
  .dock-count {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 0.7rem;
    color: var(--muted);
    white-space: nowrap;
  }
  .dock-title {
    font-size: 12px;
  }
  .dock-toggle:focus-visible {
    outline: 1px solid var(--accent);
    outline-offset: -1px;
  }
  @container (max-width: 250px) {
    .dock-count {
      display: none;
    }
  }
  .chevron {
    margin-left: auto;
    transition: rotate var(--motion-select) var(--motion-ease-spatial);
  }
  .dock-toggle[aria-expanded="true"] .chevron {
    rotate: 180deg;
  }
  .dock-panel {
    height: var(--dock-height);
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    min-height: 0;
    overflow: hidden;
    padding: 0 10px 8px;
    transition:
      height var(--motion-enter) var(--motion-ease-spatial),
      opacity var(--motion-exit) var(--motion-ease),
      padding-bottom var(--motion-enter) var(--motion-ease-spatial),
      display var(--motion-enter) allow-discrete;
  }
  .dock-panel.resizing {
    transition: none;
  }
  .dock-panel[hidden] {
    display: none;
    height: 0;
    opacity: 0;
    padding-bottom: 0;
  }
  @starting-style {
    .dock-panel:not([hidden]) {
      height: 0;
      opacity: 0;
      padding-bottom: 0;
    }
  }
  .height-resize {
    flex: 0 0 10px;
    margin: 0 -10px 4px;
    cursor: row-resize;
    touch-action: none;
    position: relative;
    outline-offset: -2px;
  }
  .height-resize::after {
    content: "";
    position: absolute;
    left: calc(50% - 16px);
    top: 3px;
    width: 32px;
    height: 3px;
    border-radius: 2px;
    background: var(--border);
  }
  .height-resize:hover::after,
  .height-resize:focus-visible::after,
  .height-resize.resizing::after {
    background: var(--accent);
  }
  .relation-tabs {
    display: flex;
    gap: 4px;
    padding: 5px 0 8px;
  }
  .relation-tabs button {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    flex: 1;
    min-width: 0;
    border: 0;
    border-radius: 6px;
    padding: 6px 2px;
    background: transparent;
    color: var(--muted);
    font: inherit;
    font-size: 0.75rem;
    cursor: pointer;
  }
  .relation-tabs button[aria-pressed="true"] {
    color: var(--fg);
    background: var(--surface);
    box-shadow: 0 1px 3px var(--shadow);
  }
  .relation-tabs span {
    font-variant-numeric: tabular-nums;
  }
  .tab-symbol {
    font-size: 1rem;
    line-height: 1;
  }
  .direction-icon {
    width: 24px;
    height: 16px;
    flex-shrink: 0;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
  }
  .direction-icon circle {
    fill: currentColor;
    stroke: none;
  }
  .relation-list {
    flex: 1;
    min-height: 0;
    overflow: auto;
    overscroll-behavior: contain;
  }
  .empty {
    color: var(--muted);
    font-size: 0.8rem;
    line-height: 1.7;
    padding: 0.5rem;
    text-align: center;
  }
</style>
