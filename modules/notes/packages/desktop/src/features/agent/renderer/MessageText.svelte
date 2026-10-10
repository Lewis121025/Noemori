<script lang="ts">
  import type { Nodes } from "mdast";
  import { textPalette } from "../../reader/shared/markdown/text-style";
  import { parseMessageMarkdown } from "./message-markdown";
  import CodeBlock from "./CodeBlock.svelte";
  import MermaidPreview from "./MermaidPreview.svelte";
  import MathContent from "./MathContent.svelte";
  import HtmlPreview from "./HtmlPreview.svelte";
  import ContentCard from "./ContentCard.svelte";
  import type { AgentApi } from "../shared/api";
  let {
    text,
    openLink,
    api,
    session = "",
    onInspect,
  }: {
    text: string;
    openLink: (url: string) => Promise<void>;
    api?: AgentApi | undefined;
    session?: string;
    onInspect?: (() => void) | undefined;
  } = $props();
  const message = $derived(parseMessageMarkdown(text));
  const id = $props.id();
  let host: HTMLDivElement;
  let issue = $state("");
  async function open(url: string): Promise<void> {
    issue = "";
    try {
      await openLink(url);
    } catch (cause) {
      issue = cause instanceof Error ? cause.message : String(cause);
    }
  }
  function jump(target: string): void {
    onInspect?.();
    const element = document.getElementById(target);
    if (element && host.contains(element)) {
      element.scrollIntoView({ block: "nearest" });
      element.focus({ preventScroll: true });
    }
  }
</script>

{#snippet nodes(items: readonly Nodes[], inline = false)}
  {#each items as node, index (index)}
    {@const link = message.links.get(node)}
    {#if node.type === "text"}{node.value}
    {:else if node.type === "paragraph"}{#if message.richParagraphs.has(node)}<div
          class="rich-paragraph"
        >
          {@render nodes(node.children, true)}
        </div>{:else}<p>{@render nodes(node.children, true)}</p>{/if}
    {:else if node.type === "heading"}<svelte:element
        this={`h${node.depth}`}
        id={`${id}-heading-${message.headings.get(node)}`}
        tabindex="-1">{@render nodes(node.children, true)}</svelte:element
      >
    {:else if node.type === "strong"}<strong>{@render nodes(node.children, true)}</strong>
    {:else if node.type === "emphasis"}<em>{@render nodes(node.children, true)}</em>
    {:else if node.type === "delete"}<del>{@render nodes(node.children, true)}</del>
    {:else if node.type === "highlight"}<mark>{@render nodes(node.children, true)}</mark>
    {:else if node.type === "textStyle"}
      {#if node.style.kind === "underline"}<u>{@render nodes(node.children, true)}</u>
      {:else if node.style.kind === "text_color"}
        {@const color = textPalette.text[node.style.color]}
        <span style:color={`light-dark(${color.light}, ${color.dark})`}
          >{@render nodes(node.children, true)}</span
        >
      {:else}
        {@const color = textPalette.highlight[node.style.color]}
        <mark style:background-color={`light-dark(${color.light}, ${color.dark})`}
          >{@render nodes(node.children, true)}</mark
        >
      {/if}
    {:else if node.type === "inlineCode"}<code>{node.value}</code>
    {:else if node.type === "inlineMath" || node.type === "math"}<MathContent
        text={node.value}
        display={node.type === "math"}
      />
    {:else if node.type === "code"}{#if node.lang?.toLowerCase() === "mermaid"}<MermaidPreview
          text={node.value}
          {onInspect}
        />
      {:else if ["html", "htm", "svg"].includes(node.lang?.toLowerCase() ?? "")}<HtmlPreview
          text={node.value}
          name={node.lang?.toLowerCase() === "svg" ? "图形.svg" : "页面.html"}
          {api}
          {onInspect}
        />{:else}<CodeBlock text={node.value} language={node.lang ?? undefined} />{/if}
    {:else if node.type === "html"}{#if inline && /^<br\s*\/?>$/i.test(node.value)}<br
        />{:else if inline}<span>{node.value}</span>{:else}<HtmlPreview
          text={node.value}
          {api}
          {onInspect}
        />{/if}
    {:else if node.type === "blockquote"}<blockquote>
        {@render nodes(node.children)}
      </blockquote>
    {:else if node.type === "list"}{#if node.ordered}<ol start={node.start ?? 1}>
          {@render nodes(node.children)}
        </ol>{:else}<ul>{@render nodes(node.children)}</ul>{/if}
    {:else if node.type === "listItem"}<li class:task-item={typeof node.checked === "boolean"}>
        {#if typeof node.checked === "boolean"}<input
            type="checkbox"
            checked={node.checked}
            disabled
            aria-label={node.checked ? "已完成" : "未完成"}
          />{/if}
        {@render nodes(node.children)}
      </li>
    {:else if (node.type === "link" || node.type === "linkReference") && link}
      {#if link.kind === "anchor"}<a
          href={`#${id}-heading-${link.fragment}`}
          onclick={(event) => {
            event.preventDefault();
            jump(`${id}-heading-${link.fragment}`);
          }}>{@render nodes(node.children, true)}</a
        >
      {:else if link.kind === "content"}<ContentCard
          source={{ type: "reference", reference: link.url }}
          {api}
          {session}
          {openLink}
          {onInspect}
        />
      {:else}<a
          href={link.url}
          title={link.title ?? undefined}
          onclick={(event) => {
            event.preventDefault();
            void open(link.url);
          }}>{@render nodes(node.children, true)}</a
        >
      {/if}
    {:else if (node.type === "image" || node.type === "imageReference") && link?.kind === "content"}<ContentCard
        source={{ type: "reference", reference: link.url }}
        label={node.alt || undefined}
        {api}
        {session}
        {openLink}
        {onInspect}
      />
    {:else if node.type === "image" || node.type === "imageReference"}<span
        >{node.alt ?? "图片"}</span
      >
    {:else if node.type === "table"}<div class="table-wrap">
        <table>
          <thead
            ><tr
              >{#each node.children[0]?.children ?? [] as cell, cellIndex (cellIndex)}
                <th scope="col" style:text-align={node.align?.[cellIndex] ?? "left"}
                  >{@render nodes(cell.children, true)}</th
                >
              {/each}</tr
            ></thead
          >
          <tbody
            >{#each node.children.slice(1) as row, rowIndex (rowIndex)}<tr
                >{#each row.children as cell, cellIndex (cellIndex)}<td
                    style:text-align={node.align?.[cellIndex] ?? "left"}
                    >{@render nodes(cell.children, true)}</td
                  >{/each}</tr
              >{/each}</tbody
          >
        </table>
      </div>
    {:else if node.type === "break"}<br />
    {:else if node.type === "thematicBreak"}<hr />
    {:else if node.type === "footnoteReference"}
      {@const reference = message.references.get(node)}
      {#if reference}<sup
          ><a
            id={`${id}-ref-${reference.number}-${reference.occurrence}`}
            href={`#${id}-fn-${reference.number}`}
            aria-label={`脚注 ${reference.number}`}
            onclick={(event) => {
              event.preventDefault();
              jump(`${id}-fn-${reference.number}`);
            }}>{reference.number}</a
          ></sup
        >{:else}<span>[^{node.label ?? node.identifier}]</span>{/if}
    {:else if node.type === "definition" || node.type === "footnoteDefinition" || node.type === "comment"}
      <!-- 定义通过链接与页脚呈现，注释在阅读消息时隐藏。 -->
    {:else if node.type === "yaml" || node.type === "toml"}<CodeBlock
        text={node.value}
        language={node.type}
      />
    {:else if "children" in node}{@render nodes(node.children, inline)}
    {:else if "value" in node}<span>{node.value}</span>{/if}
  {/each}
{/snippet}
<div class="message-text" bind:this={host}>
  {@render nodes(message.tree.children)}
  {#if message.footnotes.length}<section class="footnotes" aria-label="脚注">
      <ol>
        {#each message.footnotes as note (note.number)}<li
            id={`${id}-fn-${note.number}`}
            tabindex="-1"
          >
            {@render nodes(note.node.children)}
            {#each Array.from({ length: note.references }, (_, index) => index + 1) as occurrence (occurrence)}
              <a
                href={`#${id}-ref-${note.number}-${occurrence}`}
                aria-label={`返回脚注 ${note.number} 的第 ${occurrence} 次引用`}
                onclick={(event) => {
                  event.preventDefault();
                  jump(`${id}-ref-${note.number}-${occurrence}`);
                }}>↩</a
              >
            {/each}
          </li>{/each}
      </ol>
    </section>{/if}
</div>
{#if issue}<p class="error" role="alert">{issue}</p>{/if}

<style>
  .message-text {
    line-height: 1.75;
    font-size: 14px;
    overflow-wrap: anywhere;
    min-width: 0;
    tab-size: 2;
  }
  .message-text :global(p) {
    margin: 0.35rem 0 0.65rem;
    white-space: pre-wrap;
  }
  .rich-paragraph {
    margin: 0.35rem 0 0.65rem;
  }
  .message-text > :global(:first-child) {
    margin-top: 0;
  }
  .message-text > :global(:last-child) {
    margin-bottom: 0;
  }
  .message-text :global(h1),
  .message-text :global(h2),
  .message-text :global(h3),
  .message-text :global(h4),
  .message-text :global(h5),
  .message-text :global(h6) {
    font-weight: 550;
    line-height: 1.5;
    margin: 1.15rem 0 0.55rem;
  }
  .message-text :global(h1) {
    font-size: 21px;
  }
  .message-text :global(h2) {
    font-size: 18px;
  }
  .message-text :global(h3) {
    font-size: 16px;
  }
  .message-text :global(h4),
  .message-text :global(h5),
  .message-text :global(h6) {
    font-size: 14px;
  }
  .message-text :global(strong) {
    font-weight: 600;
  }
  .message-text :global(hr) {
    margin: 20px 0;
    border: 0;
    border-top: 1px solid var(--border);
  }
  .message-text :global(ul),
  .message-text :global(ol) {
    padding-left: 1.5rem;
    margin: 0.6rem 0;
  }
  .message-text :global(li p) {
    margin: 0.15rem 0;
  }
  .message-text :global(.task-item) {
    position: relative;
    list-style: none;
  }
  .message-text :global(.task-item input) {
    position: absolute;
    left: -1.4rem;
    top: 0.45rem;
    width: 12px;
    height: 12px;
    margin: 0;
    accent-color: var(--accent);
  }
  .message-text :global(code) {
    font-family: "JetBrains Mono Variable", monospace;
    font-size: 0.78rem;
    background: var(--sidebar);
    padding: 0.1rem 0.3rem;
    border-radius: 4px;
  }
  .message-text :global(a) {
    color: var(--accent);
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .message-text :global(blockquote) {
    margin: 0.8rem 0;
    padding-left: 1rem;
    border-left: 2px solid var(--border);
    color: var(--muted);
  }
  .table-wrap {
    overflow: auto;
    overscroll-behavior: contain;
    margin: 12px 0;
    border-radius: 10px;
  }
  table {
    border-collapse: collapse;
    width: 100%;
    font-size: 13px;
  }
  td,
  th {
    border-bottom: 1px solid var(--border);
    padding: 0.6rem 0.75rem;
    min-width: 5rem;
    text-align: left;
    vertical-align: top;
  }
  th {
    font-weight: 550;
    background: var(--bg);
  }
  tr > :last-child {
    border-right: 0;
  }
  tbody tr:last-child td {
    border-bottom: 0;
  }
  .error {
    color: var(--danger);
    font-size: 0.8rem;
  }
  .footnotes {
    margin-top: 1rem;
    border-top: 1px solid var(--border);
    color: var(--muted);
    font-size: 12px;
  }
  .footnotes a + a {
    margin-left: 0.4rem;
  }
  mark {
    background: light-dark(#fff0ae, #665720);
    color: inherit;
  }
</style>
