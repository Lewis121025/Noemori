<script lang="ts">
  import type { ReaderSearch } from "./state.svelte";
  let {
    search,
    fileCount,
    conversationCount = 0,
  }: { search: ReaderSearch; fileCount?: number; conversationCount?: number } = $props();
  const hits = $derived(search.hits);
  const matchCount = $derived(hits.reduce((total, hit) => total + hit.matchCount, 0));
  const status = $derived(
    search.error !== null
      ? `${search.error}${search.stale ? "；当前显示的是上次结果。" : ""}`
      : search.stale
        ? "笔记库已变化，正在更新搜索结果…"
        : search.busy
          ? "正在搜索…"
          : conversationCount > 0
            ? `已显示 ${conversationCount} 条对话${fileCount ? ` · ${fileCount} 篇笔记` : ""}`
            : search.semantic !== null
              ? `${search.hasMore ? "已显示 " : ""}${fileCount ?? hits.length} 篇相关笔记${search.limited ? " · 可缩小范围继续查找" : ""}${search.loadingMore ? " · 正在加载…" : ""}`
              : search.hasMore
                ? `已显示 ${fileCount ?? hits.length} 篇 · ${matchCount} 处命中${search.loadingMore ? " · 正在加载…" : ""}`
                : `共 ${fileCount ?? hits.length} 篇 · ${matchCount} 处命中`,
  );
</script>

<div class="status" role="status">{status}</div>
{#if search.error}<button type="button" onclick={() => void search.refresh()}>重新搜索</button>{/if}
{#if search.semantic !== null && search.semantic.state !== "ready"}
  <div class="semantic-status" role="status">
    {#if search.modelInstalling}
      <span>正在下载或导入本地语义模型…</span>
      <button onclick={() => search.cancelModel()}>取消</button>
    {:else if search.semantic.state === "missing"}
      <span>已启用关键词和拼写容错。安装本地模型后可按意思查找。</span>
      <button onclick={() => search.installModel("download")}>下载语义模型（约 1.1 GB）</button>
      <button onclick={() => search.installModel("import")}>导入模型</button>
    {:else if search.semantic.state === "error"}
      <span>语义搜索暂不可用：{search.semantic.message}</span>
      <button onclick={() => search.installModel("download")}>重试</button>
      <button onclick={() => search.installModel("import")}>导入模型</button>
    {:else}
      <span
        >语义索引准备中：{search.semantic.indexed} / {search.semantic.total} 篇。当前结果可能不完整。</span
      >
      <button onclick={() => search.refresh()}>刷新</button>
    {/if}
  </div>
{/if}

<style>
  .status {
    color: var(--muted);
    font-size: 11px;
    padding: 6px 12px;
  }
  .semantic-status {
    display: grid;
    gap: 5px;
    padding: 8px 12px;
    font-size: 11px;
    color: var(--muted);
  }
  button {
    font: inherit;
    color: var(--fg);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 4px 6px;
    cursor: pointer;
  }
</style>
