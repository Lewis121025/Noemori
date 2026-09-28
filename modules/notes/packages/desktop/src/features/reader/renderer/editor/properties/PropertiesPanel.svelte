<script lang="ts">
  /**
   * 属性面板：frontmatter 的行级外科编辑。
   *
   * YAML 块是事实源，这里只替换值段/行区间，注释与顺序逐字节保留；
   * 块级结构（嵌套映射/序列）只读展示，编辑交给源码模式。
   * 编辑落成对源码保留块的普通事务，保存走既有保真管线。
   */
  import type { EditorState } from "prosemirror-state";
  import type { EditorView } from "prosemirror-view";
  import { documentSchema } from "../../markdown/schema";
  import { frontmatterEditKey } from "./frontmatter-presentation";
  import {
    addEntry,
    frontmatterBlock,
    frontmatterEntries,
    removeEntry,
    setEntryValue,
  } from "./frontmatter-edit";

  // 解构重命名：组件内不能存在名为 state 的变量，否则 $state 会被当作 store 订阅。
  let {
    view,
    state: editorState,
    readOnly = false,
  }: {
    view: EditorView;
    state: EditorState;
    /** 阅读视图：只展示属性，不提供修改入口。 */
    readOnly?: boolean;
  } = $props();

  const block = $derived(frontmatterBlock(editorState.doc));
  const entries = $derived(block === null ? [] : frontmatterEntries(block.text));
  /** 未提交的输入草稿；blur/Enter 才写回文档。 */
  let drafts = $state<Record<string, string>>({});
  let newKey = $state("");
  let newValue = $state("");
  let error = $state("");

  function valueOf(key: string, fallback: string): string {
    return drafts[key] ?? fallback;
  }

  /** 把新的 frontmatter 文本落成一次事务；空串表示移除整个块。 */
  function commit(nextText: string): void {
    const current = frontmatterBlock(view.state.doc);
    const tr = view.state.tr.setMeta(frontmatterEditKey, true);
    if (nextText === "") {
      if (current === null) return;
      tr.delete(current.pos, current.pos + current.size);
      // schema 要求文档至少一个块；删空后补空段落。
      if (tr.doc.content.size === 0) tr.insert(0, documentSchema.node("paragraph"));
    } else {
      const node = documentSchema.node("markdown_block", null, documentSchema.text(nextText));
      if (current === null) tr.insert(0, node);
      else tr.replaceWith(current.pos, current.pos + current.size, node);
    }
    view.dispatch(tr.scrollIntoView());
  }

  function commitValue(key: string): void {
    const current = block;
    const draft = drafts[key];
    delete drafts[key];
    if (current === null || draft === undefined) return;
    const next = setEntryValue(current.text, key, draft);
    if (next === null) return;
    commit(next);
  }

  function remove(key: string): void {
    const current = block;
    if (current === null) return;
    const next = removeEntry(current.text, key);
    if (next === null) return;
    delete drafts[key];
    commit(next);
  }

  function add(): void {
    const next = addEntry(block?.text ?? null, newKey, newValue);
    if (next === null) {
      error = "键名无效，或该键已存在";
      return;
    }
    error = "";
    newKey = "";
    newValue = "";
    commit(next);
  }
</script>

<details class="properties" open={block !== null} hidden={readOnly && block === null}>
  <summary>属性{entries.length > 0 ? `（${entries.length}）` : ""}</summary>
  <div class="rows">
    {#each entries as entry (entry.key)}
      <div class="row">
        <span class="key" title={entry.key}>{entry.key}</span>
        {#if entry.editable}
          <input
            class="reader-input value"
            type="text"
            autocomplete="off"
            spellcheck="false"
            aria-label="属性 {entry.key} 的值"
            readonly={readOnly}
            value={valueOf(entry.key, entry.value)}
            oninput={(event) => {
              drafts[entry.key] = event.currentTarget.value;
            }}
            onblur={() => commitValue(entry.key)}
            onkeydown={(event) => {
              if (event.isComposing) return;
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              } else if (event.key === "Escape") {
                event.preventDefault();
                delete drafts[entry.key];
                event.currentTarget.blur();
              }
            }}
          />
        {:else}
          <span class="nested" title="嵌套结构请切换到源码视图编辑">嵌套结构</span>
        {/if}
        {#if !readOnly}
          <button
            type="button"
            class="remove"
            aria-label="删除属性 {entry.key}"
            title="删除属性"
            onclick={() => remove(entry.key)}>×</button
          >
        {/if}
      </div>
    {/each}
    {#if !readOnly}<div class="row add-row">
        <input
          class="reader-input key-input"
          type="text"
          placeholder="键"
          aria-label="新属性键"
          autocomplete="off"
          spellcheck="false"
          bind:value={newKey}
        />
        <input
          class="reader-input value"
          type="text"
          placeholder="值"
          aria-label="新属性值"
          autocomplete="off"
          spellcheck="false"
          bind:value={newValue}
          onkeydown={(event) => {
            if (!event.isComposing && event.key === "Enter") {
              event.preventDefault();
              add();
            }
          }}
        />
        <button
          type="button"
          class="reader-button add"
          disabled={newKey.trim() === ""}
          onclick={add}>添加</button
        >
      </div>{/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
  </div>
</details>

<style>
  .properties {
    margin: 0 0 1rem;
    border: 1px solid var(--border);
    border-radius: 0.6rem;
    background: var(--sidebar);
    font-size: 0.85rem;
  }
  summary {
    cursor: pointer;
    color: var(--muted);
    padding: 0.45rem 0.75rem;
    width: fit-content;
  }
  summary:hover,
  details[open] > summary {
    color: var(--fg);
  }
  .rows {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    padding: 0.25rem 0.75rem 0.75rem;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .key {
    flex: 0 0 8.5rem;
    min-width: 0;
    color: var(--muted);
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .value {
    flex: 1 1 auto;
    min-width: 0;
    font-size: 0.85rem;
    padding: 0.3rem 0.5rem;
  }
  .nested {
    flex: 1 1 auto;
    color: var(--muted);
    font-style: italic;
  }
  .remove {
    flex-shrink: 0;
    border: 0;
    background: transparent;
    color: var(--muted);
    font-size: 1rem;
    line-height: 1;
    padding: 0.25rem 0.4rem;
    border-radius: 0.35rem;
    cursor: pointer;
  }
  .remove:hover {
    color: var(--danger);
    background: var(--selected);
  }
  .add-row .key-input {
    flex: 0 0 8.5rem;
    min-width: 0;
    font-size: 0.85rem;
    padding: 0.3rem 0.5rem;
  }
  .add {
    flex-shrink: 0;
    padding: 0.3rem 0.6rem;
  }
  .error {
    color: var(--danger);
    margin: 0;
    font-size: 0.8rem;
  }
</style>
