<script lang="ts">
  /**
   * 内联链接补全弹层：纯展示，状态与键盘拦截由编辑器持有。
   * 固定定位于光标处；下方空间不足时由调用方翻转为 bottom 定位。
   */
  import type { LinkSuggestion } from "../../engine/editing/link-suggest/candidates";

  let {
    items,
    selected,
    x,
    top,
    bottom,
    onChoose,
    onHover,
  }: {
    items: LinkSuggestion[];
    selected: number;
    /** 视口横坐标（光标处，调用方已做右侧夹取）。 */
    x: number;
    /** 向下展开时的视口 top；与 bottom 二选一。 */
    top: number | null;
    /** 向上展开时的视口 bottom；与 top 二选一。 */
    bottom: number | null;
    onChoose: (index: number) => void;
    onHover: (index: number) => void;
  } = $props();

  let listElement: HTMLUListElement | undefined = $state();

  // 选中项始终可见；焦点保持在编辑器里，这里只滚动列表。
  $effect(() => {
    const list = listElement;
    const index = selected;
    if (list === undefined) return;
    list
      .querySelector<HTMLElement>(`[data-index='${index}']`)
      ?.scrollIntoView({ block: "nearest" });
  });
</script>

<ul
  class="suggest-popup"
  role="listbox"
  aria-label="链接补全候选"
  bind:this={listElement}
  style:left="{x}px"
  style:top={top === null ? undefined : `${top}px`}
  style:bottom={bottom === null ? undefined : `${bottom}px`}
>
  <!-- 别名候选与其文件候选共用插入值，键需带上别名。 -->
  {#each items as item, index (`${item.value}|${item.alias ?? ""}`)}
    <li
      role="option"
      aria-selected={index === selected}
      data-index={index}
      class:item
      class:selected={index === selected}
      onmousedown={(event) => {
        // 弹层不夺焦点：按下即选择，编辑器保持选区与输入法状态。
        event.preventDefault();
        onChoose(index);
      }}
      onmousemove={() => onHover(index)}
    >
      <span class="label">{item.label}</span>
      {#if item.detail !== "" && item.detail !== item.label}
        <span class="detail">{item.detail}</span>
      {/if}
    </li>
  {/each}
</ul>

<style>
  .suggest-popup {
    position: fixed;
    z-index: 40;
    width: min(21rem, calc(100vw - 1rem));
    max-height: 17rem;
    overflow: auto;
    margin: 0;
    padding: 0.25rem;
    list-style: none;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 0.55rem;
    box-shadow: 0 12px 32px var(--shadow);
  }
  .item {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    padding: 0.35rem 0.5rem;
    border-radius: 0.4rem;
    cursor: pointer;
  }
  .item.selected {
    background: var(--selected);
  }
  .label {
    font-size: 0.85rem;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .detail {
    color: var(--muted);
    font-size: 0.7rem;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    direction: rtl;
  }
</style>
