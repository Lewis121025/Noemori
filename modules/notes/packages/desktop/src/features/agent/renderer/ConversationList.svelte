<script lang="ts">
  import type { AgentConversationInfo } from "../shared/api";
  let {
    items,
    selected,
    loading,
    onSelect,
    onCreate,
    onSettings,
    query = $bindable(""),
    archived = $bindable(false),
    articleFilter = null,
    onClearArticle,
  }: {
    query?: string;
    archived?: boolean;
    articleFilter?: { root: string; path: string } | null;
    onClearArticle?: () => void;
    items: AgentConversationInfo[];
    selected: string | null;
    loading: boolean;
    onSelect: (id: string) => void;
    onCreate: () => void;
    onSettings: () => void;
  } = $props();
  const shown = $derived(
    items.filter(
      (item) =>
        item.archived === archived &&
        (!articleFilter ||
          (item.workspace === articleFilter.root && item.article?.path === articleFilter.path)) &&
        `${item.title} ${item.workspace} ${item.article?.path ?? ""}`
          .toLocaleLowerCase()
          .includes(query.trim().toLocaleLowerCase()),
    ),
  );
  const date = (value: number) =>
    new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(value);
</script>

<nav class="conversations" aria-label="Agent 对话列表">
  <header>
    <h2>工作区助手</h2>
    <p>让想法变成进展</p>
  </header>
  {#if articleFilter}<div class="article-filter">
      <span>{articleFilter.path}</span><button
        class="reader-button"
        type="button"
        onclick={onClearArticle}>查看全部对话</button
      >
    </div>
  {:else}<button class="reader-button primary new-conversation" type="button" onclick={onCreate}
      >＋ 新会话</button
    >{/if}
  <input
    class="reader-input"
    type="search"
    aria-label="搜索对话"
    placeholder="搜索对话或工作目录"
    bind:value={query}
  />
  <div class="list-tabs" role="group" aria-label="对话范围">
    <button type="button" aria-pressed={!archived} onclick={() => (archived = false)}>对话</button>
    <button type="button" aria-pressed={archived} onclick={() => (archived = true)}>已归档</button>
  </div>
  <div class="conversation-items" aria-busy={loading}>
    {#each shown as item (item.id)}
      <button
        type="button"
        class="conversation-item"
        aria-current={selected === item.id ? "page" : undefined}
        title={`${item.title}\n${item.workspace}`}
        onclick={() => onSelect(item.id)}
      >
        <span class="conversation-title">{item.title}</span>
        {#if item.article}<span class="origin-label" title={item.article.path}
            >文章 · {item.article.title}{item.article.status === "article-missing"
              ? "（已移除）"
              : ""}</span
          >{/if}
        {#if item.origin}<span class="origin-label" title={item.origin.title}
            >分支 · {item.origin.title}</span
          >{/if}
        <span class="conversation-meta"
          ><span>{item.workspace.split(/[\\/]/).at(-1)}</span><time
            datetime={new Date(item.updatedAt).toISOString()}>{date(item.updatedAt)}</time
          ></span
        >
        {#if item.status === "running"}<span class="running">正在处理</span>{/if}
      </button>
    {:else}<p class="empty">
        {loading
          ? "正在读取对话…"
          : query
            ? "没有匹配的对话"
            : archived
              ? "还没有归档的对话"
              : "创建一条对话，开始处理工作区任务。"}
      </p>{/each}
  </div>
  <button class="reader-button model-settings-button" type="button" onclick={onSettings}
    >模型接口</button
  >
</nav>

<style>
  .article-filter {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    font-size: 0.78rem;
    overflow-wrap: anywhere;
  }
  .conversations {
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
    min-width: 0;
    min-height: 0;
    padding: 1.2rem 0.8rem 0.8rem;
    background: var(--sidebar);
    border-right: 1px solid var(--border);
  }
  header {
    padding: 0 0.45rem 0.3rem;
  }
  h2 {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
  }
  header p {
    margin: 0.35rem 0 0;
    color: var(--muted);
    font-size: 0.73rem;
  }
  .new-conversation {
    min-height: 36px;
    text-align: left;
  }
  input {
    width: 100%;
    min-width: 0;
    font-size: 0.76rem;
  }
  .list-tabs {
    display: flex;
    gap: 4px;
    padding: 3px;
    border-radius: 8px;
    background: var(--border);
  }
  .list-tabs button {
    flex: 1;
    border: 0;
    border-radius: 5px;
    padding: 5px;
    color: var(--muted);
    background: transparent;
    font: inherit;
    font-size: 0.73rem;
    cursor: pointer;
  }
  .list-tabs [aria-pressed="true"] {
    background: var(--bg);
    color: var(--fg);
    box-shadow: 0 1px 3px var(--shadow);
  }
  .conversation-items {
    flex: 1;
    min-height: 0;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .conversation-item {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 0.4rem;
    width: 100%;
    padding: 0.7rem;
    color: inherit;
    font: inherit;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 8px;
    text-align: left;
    cursor: pointer;
  }
  .conversation-item:hover {
    background: var(--surface);
  }
  .conversation-item[aria-current="page"] {
    background: var(--selected);
    border-color: var(--border);
  }
  .conversation-title {
    font-size: 0.82rem;
    font-weight: 500;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .origin-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.67rem;
    color: var(--muted);
  }
  .conversation-meta {
    display: flex;
    gap: 0.5rem;
    color: var(--muted);
    font-size: 0.67rem;
  }
  .conversation-meta > span {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .running {
    color: var(--accent);
    font-size: 0.68rem;
  }
  .empty {
    padding: 1rem 0.6rem;
    font-size: 0.8rem;
    color: var(--muted);
    line-height: 1.7;
  }
  .model-settings-button {
    text-align: left;
    border-top: 1px solid var(--border);
    padding-top: 0.75rem;
  }
</style>
