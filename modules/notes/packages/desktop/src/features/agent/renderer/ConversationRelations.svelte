<script lang="ts">
  import type { AgentConversation, AgentConversationInfo } from "../shared/api";
  let {
    current,
    items,
    onSelect,
  }: {
    current: AgentConversation;
    items: AgentConversationInfo[];
    onSelect: (id: string, turnId?: string | null) => void;
  } = $props();
  const source = $derived(items.find((item) => item.id === current.origin?.conversationId));
  const branches = $derived(items.filter((item) => item.origin?.conversationId === current.id));
</script>

{#if current.origin || branches.length > 0}
  <nav class="conversation-relations" aria-label="对话关系">
    {#if current.origin}<span>分叉自</span>
      {#if source}<button
          type="button"
          class="reader-button"
          title={source.title}
          onclick={() => onSelect(source.id, current.origin?.turnId)}>{source.title}</button
        >
      {:else}<span class="missing">{current.origin.title}（原会话已删除）</span>{/if}
    {/if}
    {#if branches.length > 0}<details>
        <summary>{branches.length} 条分支</summary>
        <div class="branches">
          {#each branches as branch (branch.id)}<button
              class="reader-button"
              type="button"
              title={branch.title}
              onclick={() => onSelect(branch.id)}
              >{branch.title}{branch.archived ? " · 已归档" : ""}</button
            >{/each}
        </div>
      </details>{/if}
  </nav>
{/if}

<style>
  .conversation-relations {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.4rem;
    padding: 0.4rem 1.5rem;
    border-bottom: 1px solid var(--border);
    color: var(--muted);
    font-size: 0.75rem;
  }
  button {
    font-size: inherit;
    padding: 0.2rem 0.4rem;
    min-width: 0;
    max-width: 25rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .missing {
    overflow-wrap: anywhere;
  }
  summary {
    cursor: pointer;
    padding: 0.25rem 0;
  }
  details {
    flex-basis: 100%;
  }
  .branches {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    padding: 0.3rem 0;
  }
  @media (max-width: 800px) {
    .conversation-relations {
      padding-inline: 0.75rem;
    }
    button {
      max-width: calc(100vw - 6rem);
    }
  }
</style>
