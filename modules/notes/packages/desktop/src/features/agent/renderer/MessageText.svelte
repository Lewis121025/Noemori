<script lang="ts">
  import { markdownProcessor } from "../../reader/shared/markdown/markdown-processor";
  /** 只渲染结构与文本，不执行 HTML，也不自动请求模型消息中的外部图片。 */
  type RenderNode = {
    type: string;
    value?: string | undefined;
    url?: string | undefined;
    alt?: string | null | undefined;
    depth?: number | undefined;
    ordered?: boolean | null | undefined;
    start?: number | null | undefined;
    children?: RenderNode[] | undefined;
  };
  let { text, openLink }: { text: string; openLink: (url: string) => Promise<void> } = $props();
  const tree = $derived(markdownProcessor.parse(text));
  let issue = $state("");
  function safeUrl(value: string): boolean {
    try {
      const url = new URL(value);
      return url.protocol === "https:" || url.protocol === "http:";
    } catch {
      return false;
    }
  }
  async function open(url: string): Promise<void> {
    try {
      await openLink(url);
    } catch (cause) {
      issue = cause instanceof Error ? cause.message : String(cause);
    }
  }
</script>

{#snippet nodes(items: readonly RenderNode[])}
  {#each items as node, index (index)}
    {#if node.type === "text"}{node.value}
    {:else if node.type === "paragraph"}<p>{@render nodes(node.children ?? [])}</p>
    {:else if node.type === "heading"}<svelte:element
        this={`h${Math.min(6, Math.max(1, node.depth ?? 2))}`}
        >{@render nodes(node.children ?? [])}</svelte:element
      >
    {:else if node.type === "strong"}<strong>{@render nodes(node.children ?? [])}</strong>
    {:else if node.type === "emphasis"}<em>{@render nodes(node.children ?? [])}</em>
    {:else if node.type === "delete"}<del>{@render nodes(node.children ?? [])}</del>
    {:else if node.type === "inlineCode"}<code>{node.value}</code>
    {:else if node.type === "code"}<pre><code>{node.value}</code></pre>
    {:else if node.type === "blockquote"}<blockquote>
        {@render nodes(node.children ?? [])}
      </blockquote>
    {:else if node.type === "list"}{#if node.ordered}<ol start={node.start ?? 1}>
          {@render nodes(node.children ?? [])}
        </ol>{:else}<ul>{@render nodes(node.children ?? [])}</ul>{/if}
    {:else if node.type === "listItem"}<li>{@render nodes(node.children ?? [])}</li>
    {:else if node.type === "link" && node.url && safeUrl(node.url)}<a
        href={node.url}
        onclick={(event) => {
          event.preventDefault();
          if (node.url) void open(node.url);
        }}>{@render nodes(node.children ?? [])}</a
      >
    {:else if node.type === "image"}<span class="image-reference"
        >[图片：{node.alt || node.url}]</span
      >
    {:else if node.type === "table"}<div class="table-wrap">
        <table><tbody>{@render nodes(node.children ?? [])}</tbody></table>
      </div>
    {:else if node.type === "tableRow"}<tr>{@render nodes(node.children ?? [])}</tr>
    {:else if node.type === "tableCell"}<td>{@render nodes(node.children ?? [])}</td>
    {:else if node.type === "break"}<br />
    {:else if node.type === "thematicBreak"}<hr />
    {:else if node.children}{@render nodes(node.children)}
    {:else if node.value}<span>{node.value}</span>{/if}
  {/each}
{/snippet}
<div class="message-text">{@render nodes(tree.children)}</div>
{#if issue}<p class="error" role="alert">{issue}</p>{/if}

<style>
  .message-text {
    line-height: 1.8;
    font-size: 0.88rem;
    overflow-wrap: anywhere;
    min-width: 0;
  }
  .message-text :global(p) {
    margin: 0.35rem 0 0.8rem;
    white-space: pre-wrap;
  }
  .message-text :global(h1),
  .message-text :global(h2),
  .message-text :global(h3) {
    font-size: 1.08rem;
    line-height: 1.5;
    margin: 1.1rem 0 0.5rem;
  }
  .message-text :global(ul),
  .message-text :global(ol) {
    padding-left: 1.5rem;
    margin: 0.6rem 0;
  }
  .message-text :global(li p) {
    margin: 0.15rem 0;
  }
  .message-text :global(code) {
    font-family: "JetBrains Mono Variable", monospace;
    font-size: 0.78rem;
    background: var(--sidebar);
    padding: 0.1rem 0.3rem;
    border-radius: 4px;
  }
  .message-text :global(pre) {
    background: var(--sidebar);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.8rem;
    overflow: auto;
  }
  .message-text :global(pre code) {
    padding: 0;
  }
  .message-text :global(a) {
    color: var(--accent);
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .message-text :global(blockquote) {
    margin: 0.8rem 0;
    padding-left: 1rem;
    border-left: 3px solid var(--border);
    color: var(--muted);
  }
  .table-wrap {
    overflow: auto;
  }
  table {
    border-collapse: collapse;
    width: 100%;
    font-size: 0.8rem;
  }
  td {
    border: 1px solid var(--border);
    padding: 0.45rem 0.65rem;
  }
  .image-reference {
    color: var(--muted);
    font-size: 0.8rem;
  }
  .error {
    color: var(--danger);
    font-size: 0.8rem;
  }
</style>
