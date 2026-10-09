<script lang="ts">
  import { LanguageDescription } from "@codemirror/language";
  import { languages } from "@codemirror/language-data";
  import { classHighlighter, highlightTree } from "@lezer/highlight";
  import CopyButton from "./CopyButton.svelte";
  let { text, language = "" }: { text: string; language?: string | undefined } = $props();
  type Token = { text: string; classes: string };
  let tokens = $state<Token[]>([]);
  let version = 0;

  $effect(() => {
    const request = ++version;
    tokens = [{ text, classes: "" }];
    void highlight(text, language, request);
    return () => { version += 1; };
  });

  // 高亮是渐进增强；长输出保留原文，过期语言加载不能覆盖新代码或已卸载视图。
  async function highlight(value: string, name: string, request: number): Promise<void> {
    if (!name || value.length > 50_000) return;
    const description = LanguageDescription.matchLanguageName(languages, name, false);
    if (!description) return;
    try {
      const support = await description.load();
      if (request !== version) return;
      const result: Token[] = [];
      let position = 0;
      highlightTree(support.language.parser.parse(value), classHighlighter, (from, to, classes) => {
        if (from > position) result.push({ text: value.slice(position, from), classes: "" });
        result.push({ text: value.slice(from, to), classes });
        position = to;
      });
      if (position < value.length) result.push({ text: value.slice(position), classes: "" });
      tokens = result;
    } catch (cause) {
      if (request === version) console.warn("代码高亮加载失败，保留原文", cause);
    }
  }
</script>

<div class="code-block">
  <div class="code-header"><span class="code-language">{language || "代码"}</span><CopyButton {text} label="复制代码" iconOnly /></div>
  <pre><code>{#each tokens as token, index (index)}{#if token.classes}<span class={token.classes}>{token.text}</span>{:else}{token.text}{/if}{/each}</code></pre>
</div>

<style>
  .code-block {
    margin: 12px 0;
    border-radius: 10px;
    overflow: hidden;
    background: color-mix(in srgb, var(--fg) 3%, var(--bg));
  }
  .code-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 5px 8px 0 14px;
    color: var(--muted);
    font-size: 11px;
  }
  .code-language {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  pre {
    margin: 0;
    padding: 8px 14px 14px;
    max-height: 22rem;
    overflow: auto;
    overscroll-behavior: contain;
    scrollbar-width: thin;
    white-space: pre;
    line-height: 1.75;
    tab-size: 2;
  }
  .code-block pre code {
    font-family: "JetBrains Mono Variable", monospace;
    font-size: 12px;
    color: var(--fg);
    padding: 0;
    border-radius: 0;
    background: transparent;
  }
  code :global(.tok-keyword),
  code :global(.tok-modifier) {
    color: light-dark(#8b4f73, #d5a4c6);
  }
  code :global(.tok-string),
  code :global(.tok-regexp) {
    color: light-dark(#3f705c, #a3c6b0);
  }
  code :global(.tok-number),
  code :global(.tok-bool),
  code :global(.tok-literal) {
    color: light-dark(#3d6792, #a8bfdc);
  }
  code :global(.tok-comment),
  code :global(.tok-meta) {
    color: var(--muted);
  }
  code :global(.tok-typeName),
  code :global(.tok-className),
  code :global(.tok-labelName) {
    color: light-dark(#8c612e, #d7ba89);
  }
</style>
