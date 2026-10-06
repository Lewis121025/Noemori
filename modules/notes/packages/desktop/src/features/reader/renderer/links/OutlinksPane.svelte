<script lang="ts">
  /** 目标与引用次数分开显示；每次打开仍携带原始链接，保留实时解析和标题定位。 */
  import type { LinkRecord } from "../../shared/api";
  import type { OutlinkGroups, OutlinkGroup } from "./outlinks";
  let { groups, onOpen }: { groups: OutlinkGroups; onOpen: (link: LinkRecord) => void } = $props();
  const targets = $derived(
    [...groups.resolved, ...groups.ambiguous, ...groups.dead].sort(
      (left, right) => left.items[0].startByte - right.items[0].startByte,
    ),
  );
</script>

{#if targets.length > 0 || groups.self.length > 0}
  <section class="outlinks" aria-label="本文出链">
    {@render targetList(targets)}
    {#if groups.self.length > 0}
      <section class="local-anchors" aria-label="本文内部跳转">
        <div class="local-marker" title="本文内部跳转，不计入出链目标数" aria-label="本文内部跳转">
          #
        </div>
        {@render targetList(groups.self)}
      </section>
    {/if}
  </section>
{/if}

{#snippet targetList(items: OutlinkGroup[])}
  <ul>
    {#each items as group (group.key)}
      <li class="outlink-group">
        {#if group.items.length === 1}
          <button
            type="button"
            class="hit"
            title={group.target}
            data-preview-path={group.resolution === "resolved" ? group.target : undefined}
            onclick={() => onOpen(group.items[0])}>{@render targetHeading(group)}</button
          >
        {:else}
          <div class="hit" title={group.target}>{@render targetHeading(group)}</div>
        {/if}
        {#if group.resolution === "resolved" && group.target.includes("/")}<div
            class="target-path"
            title={group.target}
          >
            {group.target.slice(0, group.target.lastIndexOf("/"))}
          </div>{/if}
        {#if group.items.length > 1}
          <div class="occurrences">
            {#each group.items as item, index (`${item.startByte}:${index}`)}
              <button
                type="button"
                class="occurrence"
                aria-label={`第 ${index + 1} 处引用：${item.toRaw}`}
                title={item.toRaw}
                data-preview-path={group.resolution === "resolved" ? group.target : undefined}
                onclick={() => onOpen(item)}
              >
                <span class="occurrence-index">{index + 1}</span><span class="occurrence-label"
                  >{item.toRaw}</span
                >
              </button>
            {/each}
          </div>
        {/if}
      </li>
    {/each}
  </ul>
{/snippet}

{#snippet targetHeading(group: OutlinkGroup)}
  <span class="raw"
    >{group.resolution === "resolved" ? group.target.split("/").at(-1) : group.target}</span
  >
  {#if group.items.length > 1}<span class="occurrence-count" title={`引用 ${group.items.length} 次`}
      >×{group.items.length}</span
    >{/if}
  {#if group.resolution === "ambiguous"}<span
      class="link-state"
      role="img"
      aria-label="选择同名目标"
      title="有多个同名文件，请选择">?</span
    >
  {:else if group.resolution === "dead"}<span
      class="link-state"
      role="img"
      aria-label="创建目标"
      title="尚未创建，点击开始记录">+</span
    >{/if}
{/snippet}

<style>
  .outlinks {
    padding: 0.4rem 0;
    font-size: 0.8rem;
  }
  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li + li {
    margin-top: 0.5rem;
  }
  .outlink-group {
    padding: 0.5rem 0.6rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
  }
  button {
    border: 0;
    background: transparent;
    color: var(--fg);
    font: inherit;
    cursor: pointer;
  }
  .hit {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 0.2rem 0;
    text-align: left;
  }
  .raw {
    flex: 1;
    min-width: 0;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .occurrence-count,
  .link-state {
    color: var(--muted);
    flex-shrink: 0;
    font-size: 0.72rem;
  }
  .link-state {
    width: 18px;
    text-align: center;
    border: 1px solid var(--border);
    border-radius: 4px;
  }
  .target-path {
    font-size: 0.7rem;
    color: var(--muted);
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .occurrences {
    border-top: 1px solid var(--border);
    margin-top: 0.35rem;
    padding-top: 0.2rem;
  }
  .occurrence {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 0.25rem 0;
    text-align: left;
    border-radius: 4px;
  }
  button:hover {
    color: var(--accent);
    background: var(--selected);
  }
  .occurrence-index {
    color: var(--muted);
    font-size: 0.65rem;
    width: 14px;
    flex-shrink: 0;
  }
  .occurrence-label {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: 0.72rem;
  }
  .local-anchors {
    margin-top: 0.5rem;
    padding-top: 0.4rem;
    border-top: 1px solid var(--border);
  }
  .local-marker {
    color: var(--muted);
    padding: 0 0.2rem 0.3rem;
  }
</style>
