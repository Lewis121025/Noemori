<script lang="ts">
  import type { CreateEntryKind } from "../library/CreateEntryDialog.svelte";
  import { selectionIndicator } from "../selection-indicator";
  /** 视图切换和新建只发布意图，目录选择、焦点与创建生命周期由工作台负责。 */
  let {
    sidebarId,
    selected,
    disabled,
    onSelect,
    onCreate,
    onConversation,
  }: {
    sidebarId: string;
    selected: "files" | "outline";
    disabled: boolean;
    onSelect: (panel: "files" | "outline") => void;
    onCreate: (kind: CreateEntryKind) => void;
    onConversation?: () => void;
  } = $props();
  let createMenu: HTMLDivElement;
  const mac = navigator.userAgent.includes("Mac");
</script>

<header class="navigation-heading">
  <div class="panel-switch" role="group" aria-label="侧栏视图" use:selectionIndicator={selected}>
    <button
      class="reader-button panel-toggle"
      type="button"
      aria-label="文件目录"
      title="文件目录"
      aria-pressed={selected === "files"}
      aria-controls={`${sidebarId}-files`}
      onclick={() => onSelect("files")}>文件</button
    >
    <button
      class="reader-button panel-toggle"
      type="button"
      aria-label="文章大纲"
      title="文章大纲"
      aria-pressed={selected === "outline"}
      aria-controls={`${sidebarId}-outline`}
      onclick={() => onSelect("outline")}>大纲</button
    >
  </div>
  <button
    class="reader-button create-toggle"
    type="button"
    aria-label="新建"
    title="新建"
    popovertarget={`${sidebarId}-create`}
    {disabled}
    ><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12" /></svg>
    <span class="create-label">新建</span></button
  >
  <div
    id={`${sidebarId}-create`}
    popover="auto"
    bind:this={createMenu}
    class="reader-popover create-menu"
    aria-label="新建项目"
  >
    <button
      type="button"
      aria-label="新建笔记"
      onclick={() => {
        createMenu.hidePopover();
        void onCreate("note");
      }}>笔记<span>{mac ? "⌘N" : "Ctrl+N"}</span></button
    >
    <button
      type="button"
      aria-label="新建白板"
      onclick={() => {
        createMenu.hidePopover();
        void onCreate("whiteboard");
      }}>白板</button
    >
    <button
      type="button"
      aria-label="新建文件夹"
      onclick={() => {
        createMenu.hidePopover();
        void onCreate("directory");
      }}>文件夹<span>{mac ? "⇧⌘N" : "Ctrl+Shift+N"}</span></button
    >
    {#if onConversation}<button
        type="button"
        onclick={() => {
          createMenu.hidePopover();
          onConversation?.();
        }}>Agent 对话</button
      >{/if}
  </div>
</header>

<style>
  .navigation-heading {
    container-type: inline-size;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 10px;
    min-height: 42px;
    box-sizing: border-box;
  }
  .panel-switch {
    display: flex;
    gap: 3px;
  }
  .panel-toggle {
    position: relative;
    min-height: 28px;
    padding: 0 10px;
    border: 0;
    border-radius: 6px;
    color: var(--muted);
    background: transparent;
    font-size: 12px;
    font-weight: 400;
  }
  .panel-toggle[aria-pressed="true"] {
    color: var(--fg);
    font-weight: 500;
    background: color-mix(in srgb, var(--fg) 8%, transparent);
  }
  .panel-toggle:focus-visible,
  .create-toggle:focus-visible {
    outline: 1px solid var(--accent);
    outline-offset: -1px;
  }
  .create-toggle {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 3px;
    margin-left: auto;
    min-width: 28px;
    min-height: 28px;
    height: 28px;
    padding: 0 5px;
    border: 0;
    border-radius: 6px;
    color: var(--muted);
    background: transparent;
  }
  .panel-toggle:hover,
  .create-toggle:hover:not(:disabled) {
    color: var(--fg);
    background: var(--selected);
  }
  .create-toggle svg {
    width: 15px;
    height: 15px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .create-label {
    font-size: 12px;
  }
  @container (max-width: 250px) {
    .create-label {
      display: none;
    }
  }
  @media (pointer: coarse) {
    .panel-toggle,
    .create-toggle {
      min-width: 44px;
      min-height: 44px;
    }
  }
  .create-menu {
    min-width: 170px;
    padding: 5px;
  }
  .create-menu button {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 20px;
    width: 100%;
    padding: 7px 10px;
    color: var(--fg);
    background: transparent;
    border: 0;
    border-radius: 4px;
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .create-menu button:hover {
    background: var(--selected);
  }
  .create-menu span {
    color: var(--muted);
    font-size: 10px;
  }
</style>
