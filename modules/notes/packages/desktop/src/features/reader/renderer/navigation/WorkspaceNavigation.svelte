<script lang="ts">
  import type { CreateEntryKind } from "../library/CreateEntryDialog.svelte";
  import { selectionIndicator } from "../selection-indicator";
  import LibraryIcon from "../library/LibraryIcon.svelte";
  import { menuNavigation } from "../library/menu-navigation";
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
  let createOpen = $state(false);
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
    aria-expanded={createOpen}
    popovertarget={`${sidebarId}-create`}
    {disabled}
    ><LibraryIcon name="plus" />
    <span class="create-label">新建</span></button
  >
  <div
    id={`${sidebarId}-create`}
    popover="auto"
    bind:this={createMenu}
    class="reader-popover create-menu"
    aria-label="新建项目"
    use:menuNavigation
    ontoggle={(event) => (createOpen = event.newState === "open")}
  >
    <button
      type="button"
      aria-label="新建笔记"
      onclick={() => {
        createMenu.hidePopover();
        void onCreate("note");
      }}
      ><span class="menu-icon"><LibraryIcon name="note" /></span><span class="menu-label">笔记</span
      ><span class="shortcut">{mac ? "⌘N" : "Ctrl+N"}</span></button
    >
    <button
      type="button"
      aria-label="新建白板"
      onclick={() => {
        createMenu.hidePopover();
        void onCreate("whiteboard");
      }}
      ><span class="menu-icon"><LibraryIcon name="whiteboard" /></span><span class="menu-label"
        >白板</span
      ></button
    >
    <button
      type="button"
      aria-label="新建文件夹"
      onclick={() => {
        createMenu.hidePopover();
        void onCreate("directory");
      }}
      ><span class="menu-icon"><LibraryIcon name="folder" /></span><span class="menu-label"
        >文件夹</span
      ><span class="shortcut">{mac ? "⇧⌘N" : "Ctrl+Shift+N"}</span></button
    >
    {#if onConversation}<button
        type="button"
        onclick={() => {
          createMenu.hidePopover();
          onConversation?.();
        }}
        ><span class="menu-icon"><LibraryIcon name="conversation" /></span><span class="menu-label"
          >Agent 对话</span
        ></button
      >{/if}
  </div>
</header>

<style>
  .navigation-heading {
    container-type: inline-size;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 3px 12px 0;
    min-height: 38px;
    box-sizing: border-box;
  }
  .panel-switch {
    display: flex;
    gap: 14px;
  }
  .panel-switch:global([data-motion-selection]) {
    --selection-radius: 0;
    --selection-fill: linear-gradient(to top, var(--fg) 0 1.5px, transparent 1.5px);
  }
  .panel-toggle {
    position: relative;
    min-width: 0;
    min-height: 30px;
    padding: 0 1px;
    border: 0;
    border-radius: 0;
    color: var(--muted);
    background: transparent;
    font-size: 12px;
    font-weight: 400;
  }
  .panel-toggle[aria-pressed="true"] {
    color: var(--fg);
    font-weight: 500;
    background: transparent;
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
  .panel-toggle:hover {
    color: var(--fg);
    background: transparent;
  }
  .create-toggle:hover:not(:disabled),
  .create-toggle[aria-expanded="true"] {
    color: var(--fg);
    background: var(--selected);
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
    gap: 9px;
    width: 100%;
    min-height: 29px;
    padding: 6px 9px;
    color: var(--fg);
    background: transparent;
    border: 0;
    border-radius: 4px;
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .create-menu button:hover,
  .create-menu button:focus-visible {
    background: var(--selected);
    outline: none;
  }
  .menu-label {
    flex: 1;
  }
  .menu-icon {
    display: flex;
    color: color-mix(in srgb, var(--muted) 85%, transparent);
  }
  .create-menu .shortcut {
    color: var(--muted);
    font-size: 10px;
  }
</style>
