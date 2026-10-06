<script lang="ts">
  /** 双链面板的引用列表：按来源笔记分组，折叠与类别切换由底部面板统一负责。 */
  import type { MentionRecord, Mentions } from "../../shared/api";
  import {
    displaySnippet,
    groupMentionContexts,
    presentMentions,
    type MentionGroup,
  } from "./backlinks";

  type Props = {
    /** 仅包含当前笔记的查询结果；由外壳保证异步归属。 */
    mentions: Mentions;
    /** 打开来源并定位到该次出现。 */
    onOpen: (mention: MentionRecord) => void;
    /** 把未链接提及就地转为指向本笔记的链接；已链接提及没有此动作。 */
    onLinkify?: (mention: MentionRecord) => void;
  };
  let { mentions, onOpen, onLinkify }: Props = $props();
  const linkedGroups = $derived(presentMentions(mentions.linked, { query: "", sort: "pathAsc" }));
  const unlinkedGroups = $derived(
    presentMentions(mentions.unlinked, { query: "", sort: "pathAsc" }),
  );

  function pieces(snippet: string, match: string): Array<{ text: string; hit: boolean }> {
    if (match === "") {
      return [{ text: snippet, hit: false }];
    }
    const lower = snippet.toLowerCase();
    const needle = match.toLowerCase();
    const out: Array<{ text: string; hit: boolean }> = [];
    let from = 0;
    let at = lower.indexOf(needle, from);
    while (at !== -1) {
      if (at > from) {
        out.push({ text: snippet.slice(from, at), hit: false });
      }
      out.push({ text: snippet.slice(at, at + match.length), hit: true });
      from = at + match.length;
      at = lower.indexOf(needle, from);
    }
    if (from < snippet.length) {
      out.push({ text: snippet.slice(from), hit: false });
    }
    return out.length === 0 ? [{ text: snippet, hit: false }] : out;
  }
</script>

{#if linkedGroups.length > 0 || unlinkedGroups.length > 0}
  <section class="references" aria-label="笔记引用">
    {#if linkedGroups.length > 0}
      <div class="linked-references" role="group" aria-label="入链">
        {@render groups(linkedGroups)}
      </div>
    {/if}
    {#if unlinkedGroups.length > 0}
      <div class="suggestions" role="group" aria-label="未链接提及">
        {@render groups(unlinkedGroups, true)}
      </div>
    {/if}
  </section>
{/if}

{#snippet groups(items: MentionGroup[], linkifyable = false)}
  <div class="groups">
    {#each items as group (group.fromPath)}
      <div class="group">
        <div class="group-heading">
          <h3 title={group.fromPath}>
            {group.fromTitle === group.fromPath
              ? group.fromPath.split("/").at(-1)
              : group.fromTitle}
          </h3>
          {#if group.items.length > 1}<span
              class="occurrence-count"
              title={`${group.items.length} 处引用`}>×{group.items.length}</span
            >{/if}
        </div>
        {#if group.fromPath.includes("/")}<p class="source-path" title={group.fromPath}>
            {group.fromPath.slice(0, group.fromPath.lastIndexOf("/"))}
          </p>{/if}
        <ul>
          {#each groupMentionContexts(group.items) as context (context.key)}
            {@const item = context.items[0]}
            {@const shown = displaySnippet(item.snippet, false, 110, item.toRaw)}
            <li>
              {#if context.items.length === 1}
                <button
                  type="button"
                  class="hit"
                  data-preview-path={item.fromPath}
                  onclick={() => onOpen(item)}>{@render contextText(shown, item.toRaw)}</button
                >
              {:else}
                <div class="hit">{@render contextText(shown, item.toRaw)}</div>
              {/if}
              {#if context.items.length > 1}<div class="occurrences" aria-label="引用位置">
                  {#each context.items as occurrence, index (`${occurrence.startByte}:${index}`)}
                    <button
                      type="button"
                      class="occurrence"
                      aria-label={`第 ${index + 1} 处引用`}
                      title={`跳转到第 ${index + 1} 处引用`}
                      onclick={() => onOpen(occurrence)}>{index + 1}</button
                    >
                  {/each}
                </div>{/if}
              {#if linkifyable && onLinkify}
                <button
                  type="button"
                  class="linkify"
                  aria-label="转为链接"
                  title="把来源文件里的这段文字就地替换为指向本笔记的链接"
                  onclick={() => onLinkify?.(item)}
                  ><svg viewBox="0 0 24 24" aria-hidden="true"
                    ><path
                      d="m10 13 4-4M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M13 8l1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0"
                    /></svg
                  ></button
                >
              {/if}
            </li>
          {/each}
        </ul>
      </div>
    {/each}
  </div>
{/snippet}

{#snippet contextText(snippet: string, match: string)}
  {#each pieces(snippet, match) as part, partIndex (`${partIndex}`)}
    {#if part.hit}<mark>{part.text}</mark>{:else}{part.text}{/if}
  {/each}
{/snippet}

<style>
  .references {
    padding: 0.5rem 0;
    font-size: 0.875rem;
  }
  .group {
    padding: 0.65rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  .source-path {
    margin: 0 0 0.5rem;
    font-size: 0.7rem;
    color: var(--muted);
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .groups {
    padding-top: 0;
  }
  .group + .group {
    margin-top: 0.6rem;
  }
  h3 {
    flex: 1;
    min-width: 0;
    font-size: 0.875rem;
    font-weight: 600;
    margin: 0 0 0.3rem;
    overflow-wrap: anywhere;
  }
  .group-heading {
    display: flex;
    align-items: baseline;
    gap: 6px;
  }
  .occurrence-count {
    color: var(--muted);
    font-size: 0.7rem;
    flex-shrink: 0;
  }
  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .hit {
    display: block;
    box-sizing: border-box;
    width: 100%;
    padding: 0.35rem 0.5rem;
    margin-left: -0.5rem;
    border: 0;
    border-radius: 0.35rem;
    background: transparent;
    color: var(--fg);
    font: inherit;
    font-size: 0.8rem;
    line-height: 1.7;
    text-align: left;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  button.hit {
    cursor: pointer;
  }
  button.hit:hover {
    color: var(--fg);
    background: var(--selected);
  }
  mark {
    color: var(--fg);
    background: var(--selected);
    font-weight: 600;
  }
  .linkify {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 28px;
    min-height: 28px;
    margin: 0.1rem 0 0.35rem 0.5rem;
    padding: 0.15rem 0.4rem;
    border: 1px solid var(--border);
    border-radius: 0.35rem;
    background: transparent;
    color: var(--muted);
    font: inherit;
    font-size: 0.72rem;
    cursor: pointer;
  }
  .linkify svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
  }
  .linkify:hover {
    color: var(--accent);
    border-color: var(--accent);
  }
  .occurrences {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin: 0.1rem 0 0.35rem;
  }
  .occurrence {
    min-width: 24px;
    min-height: 24px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: transparent;
    color: var(--muted);
    font: inherit;
    font-size: 0.7rem;
    cursor: pointer;
  }
  .occurrence:hover {
    color: var(--fg);
    background: var(--selected);
  }
</style>
