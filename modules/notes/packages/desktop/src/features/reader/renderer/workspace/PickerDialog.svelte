<script lang="ts" generics="T">
  /**
   * 快速切换器与命令面板共用的选择弹层：输入框 + 结果列表 + 按键提示。
   *
   * 只负责焦点、上下选择与按键分发；候选计算与执行动作属于调用方。
   * Esc 走原生 cancel，关闭时不执行任何动作；组词期间的 Enter 不提交。
   */
  import { onMount, tick, type Snippet } from "svelte";
  import { createCompositionGuard } from "../editor/composition";

  let {
    label,
    placeholder,
    items,
    itemKey,
    row,
    query = $bindable(""),
    hints,
    notice = "",
    empty,
    onChoose,
    onDismiss,
  }: {
    /** 弹层的无障碍名称。 */
    label: string;
    placeholder: string;
    /** 当前查询下的候选，已排序。 */
    items: readonly T[];
    /** 候选的稳定键。 */
    itemKey: (item: T) => string;
    /** 渲染一行候选。 */
    row: Snippet<[T]>;
    /** 输入框文本；调用方据此重新计算候选。 */
    query?: string;
    /** 底部按键提示。 */
    hints: ReadonlyArray<{ keys: string; label: string }>;
    /** 数据不可用等提示；空串不显示。 */
    notice?: string;
    /** 没有候选时显示的文本。 */
    empty: string;
    /**
     * 选择候选。`item` 为 `null` 表示没有候选时按下 Enter（调用方可按查询新建）。
     * `mod` 为 Cmd/Ctrl，`shift` 为 Shift。
     */
    onChoose: (item: T | null, modifiers: { mod: boolean; shift: boolean }) => void;
    onDismiss: () => void;
  } = $props();

  let dialog: HTMLDialogElement;
  let input: HTMLInputElement;
  let list: HTMLUListElement | undefined = $state();
  let selected = $state(0);
  const composition = createCompositionGuard();
  const listId = `picker-${Math.random().toString(36).slice(2)}`;

  // 查询变化后候选整体替换，选中项回到第一条。
  $effect(() => {
    void items;
    selected = 0;
  });

  onMount(() => {
    dialog.showModal();
    input.focus();
    input.select();
  });

  async function move(delta: number): Promise<void> {
    if (items.length === 0) return;
    selected = (selected + delta + items.length) % items.length;
    await tick();
    list
      ?.querySelector<HTMLElement>(`[data-index="${String(selected)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }

  function onKeydown(event: KeyboardEvent): void {
    if (composition.active) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      void move(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      void move(-1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      onChoose(items[selected] ?? null, {
        mod: event.metaKey || event.ctrlKey,
        shift: event.shiftKey,
      });
    }
  }
</script>

<dialog
  class="picker"
  bind:this={dialog}
  use:composition.bind
  aria-label={label}
  oncancel={(event) => {
    event.preventDefault();
    if (!composition.active) onDismiss();
  }}
  onclick={(event) => {
    // 点在遮罩上（dialog 自身而非内容）视为取消。
    if (event.target === dialog) onDismiss();
  }}
>
  <div class="panel">
    <input
      bind:this={input}
      bind:value={query}
      class="query"
      type="text"
      role="combobox"
      aria-expanded="true"
      aria-controls={listId}
      aria-activedescendant={items.length > 0 ? `${listId}-${String(selected)}` : undefined}
      autocomplete="off"
      spellcheck="false"
      {placeholder}
      onkeydown={onKeydown}
    />
    {#if notice !== ""}<p class="notice" role="status">{notice}</p>{/if}
    <ul id={listId} class="results" role="listbox" bind:this={list} aria-label={label}>
      {#each items as item, index (itemKey(item))}
        <!-- 键盘选择由组合框输入框经 aria-activedescendant 统一处理，选项只接收指针。 -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <li
          id={`${listId}-${String(index)}`}
          role="option"
          aria-selected={index === selected}
          class:selected={index === selected}
          data-index={index}
          onpointermove={() => {
            selected = index;
          }}
          onpointerdown={(event) => {
            // 保持输入框焦点，避免点击先让组合框失焦。
            event.preventDefault();
          }}
          onclick={(event) =>
            onChoose(item, { mod: event.metaKey || event.ctrlKey, shift: event.shiftKey })}
        >
          {@render row(item)}
        </li>
      {:else}
        <li class="empty" role="presentation">{empty}</li>
      {/each}
    </ul>
    <footer class="hints">
      {#each hints as hint (hint.keys)}
        <span><kbd>{hint.keys}</kbd>{hint.label}</span>
      {/each}
    </footer>
  </div>
</dialog>

<style>
  .picker {
    width: min(38rem, calc(100vw - 2rem));
    margin-top: 12vh;
    padding: 0;
    color: var(--fg);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 0.8rem;
    box-shadow:
      0 8px 24px var(--shadow),
      0 24px 80px var(--shadow);
  }
  .picker::backdrop {
    background: var(--scrim);
  }
  .panel {
    display: flex;
    flex-direction: column;
    max-height: min(70vh, 34rem);
  }
  .query {
    font: inherit;
    font-size: 1rem;
    color: inherit;
    background: transparent;
    border: 0;
    border-bottom: 1px solid var(--border);
    padding: 0.85rem 1rem;
    outline: none;
  }
  .notice {
    margin: 0;
    padding: 0.4rem 1rem;
    font-size: 0.8rem;
    color: var(--danger);
  }
  .results {
    list-style: none;
    margin: 0;
    padding: 0.35rem;
    overflow: auto;
    flex: 1 1 auto;
  }
  .results li {
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
    padding: 0.45rem 0.65rem;
    border-radius: 0.45rem;
    cursor: pointer;
  }
  .results li.selected {
    background: var(--selected);
  }
  .results li.empty {
    color: var(--muted);
    cursor: default;
    font-size: 0.9rem;
  }
  .hints {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    padding: 0.45rem 1rem;
    border-top: 1px solid var(--border);
    font-size: 0.75rem;
    color: var(--muted);
  }
  kbd {
    font: inherit;
    font-weight: 600;
    margin-right: 0.3rem;
  }
</style>
