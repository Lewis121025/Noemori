<script lang="ts">
  import { renderTex } from "../../reader/renderer/previews";

  let { text, display = false }: { text: string; display?: boolean } = $props();
  let host: HTMLElement;
  $effect(() => {
    const target = host,
      source = text,
      block = display;
    let current = true;
    target.textContent = block ? `$$\n${source}\n$$` : `$${source}$`;
    void renderTex(source, block).then((node) => {
      if (current) target.replaceChildren(node);
    });
    return () => {
      current = false;
    };
  });
</script>

<svelte:element
  this={display ? "div" : "span"}
  bind:this={host}
  class="math-content"
  class:display
  title={text}
></svelte:element>

<style>
  .display {
    overflow-x: auto;
    margin: 12px 0;
  }
  .math-content :global(.math-error) {
    color: var(--danger);
  }
</style>
