<script lang="ts">
  import type { CreateEntryKind } from "../library/CreateEntryDialog.svelte";
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
  <div class="panel-switch" role="group" aria-label="侧栏视图">
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
    padding: 0 10px;
    min-height: 42px;
    border-bottom: 1px solid var(--border);
  }
  .panel-switch {
    display: flex;
    gap: 2px;
  }
  .panel-toggle {
    position: relative;
    min-height: 41px;
    padding: 0 8px;
    border: 0;
    border-radius: 0;
    color: var(--muted);
    background: transparent;
    font-size: 12px;
  }
  .panel-toggle[aria-pressed="true"] {
    color: var(--fg);
    font-weight: 500;
  }
  .panel-toggle[aria-pressed="true"]::after {
    content: "";
    position: absolute;
    inset: auto 8px 0;
    height: 2px;
    background: var(--accent);
  }
  .create-toggle {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 3px;
    margin-left: auto;
    min-width: 30px;
    height: 30px;
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
