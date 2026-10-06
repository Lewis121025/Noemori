<script lang="ts">
  /** 配色保存成功后才应用；失败时保留原选择，避免界面与重启后的偏好不一致。 */
  import { onMount } from "svelte";
  import type { AppApi } from "../shared/api";
  import {
    DEFAULT_READING_PALETTE,
    READING_PALETTES,
    type ReadingPalette,
  } from "../features/reader/shared/reading-palette";

  let {
    api,
    onApply,
  }: {
    api: Pick<AppApi, "readingPaletteGet" | "readingPaletteSet">;
    onApply: (palette: ReadingPalette) => void;
  } = $props();
  const options = Object.values(READING_PALETTES);
  let selected = $state<ReadingPalette>(DEFAULT_READING_PALETTE);
  let busy = $state(true);
  let error = $state("");
  let active = true;

  function errorText(value: unknown): string {
    return value instanceof Error ? value.message : String(value);
  }

  async function restore(): Promise<void> {
    try {
      const palette = await api.readingPaletteGet();
      if (!active) return;
      onApply(palette);
      selected = palette;
    } catch (cause) {
      if (active) error = `读取阅读配色失败：${errorText(cause)}`;
    } finally {
      if (active) busy = false;
    }
  }

  async function choose(palette: ReadingPalette): Promise<void> {
    if (!active || busy || (selected === palette && error === "")) return;
    busy = true;
    error = "";
    try {
      await api.readingPaletteSet(palette);
      if (!active) return;
      onApply(palette);
      selected = palette;
    } catch (cause) {
      if (active) error = `阅读配色未能切换：${errorText(cause)}`;
    } finally {
      if (active) busy = false;
    }
  }

  onMount(() => {
    void restore();
    return () => {
      active = false;
    };
  });
</script>

<!-- 保存期间保留键盘焦点，重复操作由 choose 拒绝。 -->
<fieldset aria-label="阅读配色" aria-busy={busy}>
  <legend>阅读配色</legend>
  {#each options as option (option.id)}
    <button
      type="button"
      aria-label={option.label}
      aria-pressed={selected === option.id}
      aria-disabled={busy}
      onclick={() => void choose(option.id)}
    >
      <span class="palette-heading"
        ><span>{option.label}</span><span aria-hidden="true"
          >{selected === option.id ? "✓" : ""}</span
        ></span
      >
      <span class="palette-description">{option.description}</span>
    </button>
  {/each}
</fieldset>
{#if error}<p class="palette-error" role="alert">{error}</p>{/if}

<style>
  fieldset {
    margin: 0.75rem 0 0;
    padding: 0.35rem 0 0;
    border: 0;
    border-top: 1px solid var(--border);
    min-width: 0;
    width: 17rem;
    max-width: 100%;
  }
  legend {
    padding: 0 0.65rem;
    color: var(--muted);
    font-size: 0.75rem;
  }
  button {
    display: block;
    width: 100%;
    padding: 0.6rem 0.65rem;
    border: 1px solid transparent;
    border-radius: 0.4rem;
    font: inherit;
    color: inherit;
    background: transparent;
    text-align: left;
    cursor: pointer;
  }
  button:hover:not([aria-disabled="true"]),
  button[aria-pressed="true"] {
    background: var(--selected);
  }
  button[aria-disabled="true"] {
    cursor: default;
    opacity: 0.5;
  }
  .palette-heading {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    font-weight: 500;
  }
  .palette-description {
    display: block;
    margin-top: 0.15rem;
    color: var(--muted);
    font-size: 0.75rem;
  }
  .palette-error {
    color: var(--danger);
    padding: 0 0.65rem;
    font-size: 0.8rem;
    overflow-wrap: anywhere;
  }
</style>
