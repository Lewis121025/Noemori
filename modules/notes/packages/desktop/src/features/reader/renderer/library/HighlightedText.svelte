<script lang="ts">
  import { snippetParts } from "../search/query";
  let {
    text,
    query = "",
    snippet = false,
  }: { text: string; query?: string; snippet?: boolean } = $props();
  const parts = $derived.by(() => {
    if (snippet) return snippetParts(text);
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return [{ text, mark: false }];
    const lower = text.toLocaleLowerCase(),
      result: { text: string; mark: boolean }[] = [];
    let offset = 0,
      next: number;
    while ((next = lower.indexOf(needle, offset)) >= 0) {
      if (next > offset) result.push({ text: text.slice(offset, next), mark: false });
      result.push({ text: text.slice(next, next + needle.length), mark: true });
      offset = next + needle.length;
    }
    if (offset < text.length) result.push({ text: text.slice(offset), mark: false });
    return result;
  });
</script>

{#each parts as part, index (index)}{#if part.mark}<mark>{part.text}</mark
    >{:else}{part.text}{/if}{/each}

<style>
  mark {
    color: inherit;
    background: color-mix(in srgb, var(--accent) 15%, transparent);
    border-radius: 2px;
  }
</style>
