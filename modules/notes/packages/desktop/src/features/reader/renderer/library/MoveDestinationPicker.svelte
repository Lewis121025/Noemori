<script lang="ts">
  import { onMount, untrack } from "svelte";
  import type { MoveDestination } from "./move-destinations";
  import { rankByFuzzy } from "../search/fuzzy";
  import { isCompositionKey } from "../../shared/composition";

  let {
    destinations,
    initialPath,
    disabled,
    onSelect,
  }: {
    destinations: readonly MoveDestination[];
    initialPath: string;
    disabled: boolean;
    /** 查询无匹配或目标不可用时返回 null，使外层表单无法误提交旧目标。 */
    onSelect: (path: string | null) => void;
  } = $props();
  const id = $props.id();
  let input: HTMLInputElement;
  let list: HTMLUListElement;
  let query = $state("");
  let selected = $state<string | null>(untrack(() => initialPath));
  const matches = $derived(
    rankByFuzzy(
      query,
      destinations,
      (item) => [item.path === "" ? "笔记库根目录" : item.path],
      Infinity,
      "/ _-",
    ),
  );
  const choice = $derived(
    selected !== null
      ? (matches.find((item) => item.path === selected) ?? null)
      : (matches.find((item) => item.reason === null) ?? matches[0] ?? null),
  );
  const index = $derived(choice === null ? -1 : matches.indexOf(choice));

  onMount(() => input.focus());

  $effect(() => {
    onSelect(choice?.reason === null ? choice.path : null);
  });
  $effect(() => {
    const optionId = `${id}-${index}`;
    list.querySelector<HTMLElement>(`[id="${optionId}"]`)?.scrollIntoView({ block: "nearest" });
  });

  function keydown(event: KeyboardEvent): void {
    if (disabled || isCompositionKey(event) || event.metaKey || event.ctrlKey || event.altKey)
      return;
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const available = matches.filter((item) => item.reason === null);
    const current = available.findIndex((item) => item.path === choice?.path);
    const next =
      current < 0
        ? event.key === "ArrowDown"
          ? 0
          : available.length - 1
        : (current + (event.key === "ArrowDown" ? 1 : -1) + available.length) % available.length;
    selected = available[next]?.path ?? null;
  }
</script>

<div class="destination-picker">
  <label for={`${id}-query`}>目标文件夹</label>
  <input
    id={`${id}-query`}
    class="reader-input"
    role="combobox"
    aria-expanded="true"
    aria-autocomplete="list"
    aria-controls={`${id}-list`}
    aria-activedescendant={index < 0 ? undefined : `${id}-${index}`}
    aria-describedby={disabled ? undefined : `${id}-hint`}
    placeholder="搜索文件夹或路径…"
    autocomplete="off"
    spellcheck="false"
    bind:this={input}
    bind:value={query}
    {disabled}
    oninput={() => {
      selected = null;
    }}
    onkeydown={keydown}
  />
  <ul id={`${id}-list`} role="listbox" aria-label="目标文件夹" bind:this={list}>
    {#each matches as item, optionIndex (item.path)}
      <!-- 组合框保留键盘焦点，选项通过 aria-activedescendant 参与方向键选择。 -->
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <li
        id={`${id}-${optionIndex}`}
        role="option"
        aria-selected={item === choice}
        aria-disabled={disabled || item.reason !== null}
        title={item.path || "笔记库根目录"}
        onpointerdown={(event) => event.preventDefault()}
        onclick={() => {
          if (!disabled && item.reason === null) {
            selected = item.path;
            input.focus();
          }
        }}
      >
        <svg viewBox="0 0 20 20" aria-hidden="true"
          ><path d="M2.5 5a1 1 0 0 1 1-1h4l2 2h7a1 1 0 0 1 1 1v9h-15z" /></svg
        >
        <span class="path">{item.path || "笔记库根目录"}</span>
        {#if item.reason !== null}<span class="reason">{item.reason}</span>{/if}
      </li>
    {/each}
  </ul>
  {#if matches.length === 0}<p class="empty" role="status">没有匹配的文件夹</p>{/if}
  {#if matches.length > 0 && choice === null}<p class="empty" role="status">
      目标文件夹已不可用，请重新选择。
    </p>{/if}
  {#if !disabled}<p id={`${id}-hint`} class="hint">
      <kbd>↑↓</kbd> 选择 <kbd>Enter</kbd> 移动 <kbd>Esc</kbd> 取消
    </p>{/if}
</div>

<style>
  .destination-picker {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    min-width: 0;
  }
  label,
  .hint,
  .empty {
    font-size: 0.8rem;
    color: var(--muted);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0.25rem;
    max-height: min(14rem, 30dvh);
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: 0.55rem;
  }
  li {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-height: 2.2rem;
    padding: 0.3rem 0.5rem;
    border-radius: 0.35rem;
    font-size: 0.85rem;
    cursor: pointer;
  }
  li[aria-selected="true"],
  li:hover:not([aria-disabled="true"]) {
    background: var(--selected);
  }
  li[aria-disabled="true"] {
    color: var(--muted);
    cursor: default;
  }
  svg {
    width: 1rem;
    height: 1rem;
    flex-shrink: 0;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
    stroke-linejoin: round;
  }
  .path {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .reason {
    flex-shrink: 0;
    font-size: 0.7rem;
  }
  p {
    margin: 0;
  }
  kbd {
    font: inherit;
    margin-left: 0.6rem;
  }
  kbd:first-child {
    margin-left: 0;
  }
</style>
