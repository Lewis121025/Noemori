<script lang="ts">
  import LibraryIcon from "./LibraryIcon.svelte";
  import { menuNavigation } from "./menu-navigation";
  /** 目录的批量展开和归档对话入口集中在更多菜单，库名保留完整的横向空间。 */
  let {
    expanded,
    disabled,
    archived,
    onExpand,
    onArchive,
    onAction,
  }: {
    expanded: boolean;
    disabled: boolean;
    archived: boolean;
    onExpand: () => void;
    onArchive?: () => void;
    onAction: (action: "file" | "directory" | "import" | "reveal") => void;
  } = $props();
  const id = $props.id();
  let menu: HTMLDivElement;
  let menuOpen = $state(false);
</script>

<button
  class="options-toggle"
  type="button"
  aria-label="目录操作"
  title="更多目录操作"
  aria-expanded={menuOpen}
  popovertarget={id}
>
  <LibraryIcon name="more" />
</button>
<div
  {id}
  bind:this={menu}
  popover="auto"
  class="reader-popover options-menu"
  aria-label="目录操作"
  use:menuNavigation
  ontoggle={(event) => (menuOpen = event.newState === "open")}
>
  <button
    type="button"
    {disabled}
    onclick={() => {
      menu.hidePopover();
      onAction("file");
    }}
    ><span class="menu-icon"><LibraryIcon name="note" /></span><span class="menu-label"
      >新建笔记…</span
    ></button
  >
  <button
    type="button"
    {disabled}
    onclick={() => {
      menu.hidePopover();
      onAction("directory");
    }}
    ><span class="menu-icon"><LibraryIcon name="folder" /></span><span class="menu-label"
      >新建文件夹…</span
    ></button
  >
  <button
    type="button"
    {disabled}
    onclick={() => {
      menu.hidePopover();
      onAction("import");
    }}
    ><span class="menu-icon"><LibraryIcon name="import" /></span><span class="menu-label"
      >导入文件夹…</span
    ></button
  >
  <div class="separator" role="separator"></div>
  <button
    type="button"
    {disabled}
    onclick={() => {
      onExpand();
      menu.hidePopover();
    }}
    ><span class="menu-icon"><LibraryIcon name={expanded ? "collapse" : "expand"} /></span><span
      class="menu-label">{expanded ? "折叠全部目录" : "展开全部目录"}</span
    ></button
  >
  {#if onArchive}<button type="button" aria-pressed={archived} onclick={() => onArchive?.()}
      ><span class="menu-icon"><LibraryIcon name="archive" /></span><span class="menu-label"
        >显示归档对话</span
      >{#if archived}<LibraryIcon name="check" size={14} />{/if}</button
    >{/if}
  <div class="separator" role="separator"></div>
  <button
    type="button"
    {disabled}
    onclick={() => {
      menu.hidePopover();
      onAction("reveal");
    }}
    ><span class="menu-icon"><LibraryIcon name="reveal" /></span><span class="menu-label"
      >在系统文件夹中显示仓库</span
    ></button
  >
</div>

<style>
  .options-toggle {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    flex-shrink: 0;
    height: 28px;
    border: 0;
    padding: 3px;
    border-radius: 6px;
    background: transparent;
    color: inherit;
    cursor: pointer;
  }
  .options-menu {
    min-width: 205px;
    font-size: 12px;
  }
  .options-menu button {
    display: flex;
    gap: 9px;
    align-items: center;
    width: 100%;
    min-height: 29px;
    padding: 5px 8px;
    text-align: left;
    font: inherit;
    color: var(--fg);
    border: 0;
    border-radius: 5px;
    background: transparent;
    cursor: pointer;
  }
  button:hover:not(:disabled),
  button:focus-visible,
  .options-toggle[aria-expanded="true"] {
    background: var(--selected);
  }
  button:focus-visible {
    outline: 1px solid var(--accent);
    outline-offset: -1px;
  }
  .options-menu button:focus-visible {
    outline: none;
  }
  .menu-icon {
    display: flex;
    color: color-mix(in srgb, var(--muted) 85%, transparent);
  }
  .menu-label {
    flex: 1;
  }
  .separator {
    height: 1px;
    background: var(--border);
    margin: 5px 3px;
  }
</style>
