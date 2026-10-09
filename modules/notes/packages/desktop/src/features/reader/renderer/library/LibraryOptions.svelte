<script lang="ts">
  /** 目录的批量展开和归档对话入口集中在更多菜单，库名保留完整的横向空间。 */
  let {
    expanded,
    disabled,
    archived,
    onExpand,
    onArchive,
  }: {
    expanded: boolean;
    disabled: boolean;
    archived: boolean;
    onExpand: () => void;
    onArchive?: () => void;
  } = $props();
  const id = $props.id();
  let menu: HTMLDivElement;
</script>

<button
  class="options-toggle"
  type="button"
  aria-label="目录操作"
  title="更多目录操作"
  popovertarget={id}
>
  <svg viewBox="0 0 20 20" aria-hidden="true"
    ><circle cx="4" cy="10" r="1" /><circle cx="10" cy="10" r="1" /><circle
      cx="16"
      cy="10"
      r="1"
    /></svg
  >
</button>
<div {id} bind:this={menu} popover="auto" class="reader-popover options-menu" aria-label="目录操作">
  <button
    type="button"
    {disabled}
    onclick={() => {
      onExpand();
      menu.hidePopover();
    }}>{expanded ? "折叠全部目录" : "展开全部目录"}</button
  >
  {#if onArchive}<button type="button" aria-pressed={archived} onclick={() => onArchive?.()}
      >显示归档对话<span aria-hidden="true">{archived ? "✓" : ""}</span></button
    >{/if}
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
  svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
  }
  .options-menu {
    min-width: 170px;
    font-size: 12px;
  }
  .options-menu button {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: center;
    width: 100%;
    padding: 7px 8px;
    text-align: left;
    font: inherit;
    color: var(--fg);
    border: 0;
    border-radius: 6px;
    background: transparent;
    cursor: pointer;
  }
  button:hover {
    background: var(--selected);
  }
  .options-menu span {
    width: 12px;
  }
</style>
