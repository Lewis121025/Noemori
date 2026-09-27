<script lang="ts">
  /** 正文末尾的出链：默认收起，按解析状态分组；点击经工作区实时解析跳转。 */
  import type { LinkRecord } from "../../../shared/api";
  import { presentOutlinks } from "../../engine/navigation/outlinks";

  type Props = {
    /** 当前文档的索引出链，按文档顺序。 */
    links: LinkRecord[];
    /** 点击出链；歧义与死链由工作区统一处理。 */
    onOpen: (link: LinkRecord) => void;
  };
  let { links, onOpen }: Props = $props();
  const groups = $derived(presentOutlinks(links));
  const pending = $derived(groups.dead.length + groups.ambiguous.length);
</script>

{#if links.length > 0}
  <section class="outlinks" aria-label="本文出链">
    <details>
      <summary>链出 {links.length} 处{pending > 0 ? `（${pending} 处未唯一解析）` : ""}</summary>
      <ul>
        {#each groups.resolved as link, index (`r${index}:${link.startByte}`)}
          <li>
            <button
              type="button"
              class="hit"
              data-preview-path={link.toPath}
              onclick={() => onOpen(link)}
            >
              <span class="raw">{link.toRaw}</span>
              {#if link.toPath !== link.toRaw}<span class="target">{link.toPath}</span>{/if}
            </button>
          </li>
        {/each}
        {#each groups.ambiguous as link, index (`a${index}:${link.startByte}`)}
          <li>
            <button type="button" class="hit unresolved" onclick={() => onOpen(link)}>
              <span class="raw">{link.toRaw}</span>
              <span class="target">同名歧义</span>
            </button>
          </li>
        {/each}
        {#each groups.dead as link, index (`d${index}:${link.startByte}`)}
          <li>
            <button type="button" class="hit unresolved" onclick={() => onOpen(link)}>
              <span class="raw">{link.toRaw}</span>
              <span class="target">死链，点击创建笔记</span>
            </button>
          </li>
        {/each}
        {#each groups.self as link, index (`s${index}:${link.startByte}`)}
          <li>
            <button type="button" class="hit" onclick={() => onOpen(link)}>
              <span class="raw">{link.toRaw}</span>
              <span class="target">本文标题</span>
            </button>
          </li>
        {/each}
      </ul>
    </details>
  </section>
{/if}

<style>
  .outlinks {
    margin-top: 3rem;
    padding: 1rem 0 0.5rem;
    border-top: 1px solid var(--border);
    font-size: 0.875rem;
  }
  summary {
    color: var(--muted);
    cursor: pointer;
    padding: 0.25rem 0;
    width: fit-content;
  }
  summary:hover,
  details[open] > summary {
    color: var(--fg);
  }
  ul {
    margin: 0;
    padding: 0.5rem 0 0;
    list-style: none;
  }
  .hit {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    width: 100%;
    padding: 0.35rem 0.5rem;
    margin-left: -0.5rem;
    border: 0;
    border-radius: 0.35rem;
    background: transparent;
    color: var(--fg);
    font: inherit;
    line-height: 1.6;
    text-align: left;
    cursor: pointer;
  }
  .hit:hover {
    background: var(--selected);
  }
  .raw {
    overflow-wrap: anywhere;
  }
  .target {
    color: var(--muted);
    font-size: 0.75rem;
    overflow-wrap: anywhere;
  }
  .unresolved .raw {
    color: var(--muted);
  }
</style>
