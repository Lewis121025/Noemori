<script lang="ts">
  /** 字体准备就绪且偏好保存成功后才应用，失败时保持原选择并允许重试。 */
  import { onMount } from "svelte";
  import type { AppApi } from "../shared/api";
  import {
    DEFAULT_READING_FONT,
    READING_FONTS,
    type ReadingFont,
  } from "../features/reader/shared/reading-font";

  let {
    api,
    onApply,
  }: {
    api: Pick<AppApi, "readingFontGet" | "readingFontSet">;
    onApply: (font: ReadingFont) => Promise<void>;
  } = $props();
  const options = Object.values(READING_FONTS);
  let selected = $state<ReadingFont>(DEFAULT_READING_FONT);
  let busy = $state(true);
  let error = $state("");

  function errorText(value: unknown): string {
    return value instanceof Error ? value.message : String(value);
  }

  async function prepare(font: ReadingFont): Promise<void> {
    // 先加载当前正文的字形，避免应用新搭配后再经历一次后备字体的重排。
    const text =
      Array.from(document.querySelectorAll(".markdown-content"))
        .map((element) => element.textContent)
        .join("") || "Reading，让思考慢下来。";
    await Promise.all(
      ["400", "500", "600", "italic 400"].map((weight) =>
        document.fonts.load(`${weight} 17px ${READING_FONTS[font].family}`, text),
      ),
    );
  }

  async function restore(): Promise<void> {
    try {
      const font = await api.readingFontGet();
      await prepare(font);
      await onApply(font);
      selected = font;
    } catch (cause) {
      error = `读取阅读字体失败：${errorText(cause)}`;
    } finally {
      busy = false;
    }
  }

  async function choose(font: ReadingFont): Promise<void> {
    if (busy || (selected === font && error === "")) return;
    busy = true;
    error = "";
    try {
      await prepare(font);
      await api.readingFontSet(font);
      await onApply(font);
      selected = font;
    } catch (cause) {
      error = `阅读字体未能切换：${errorText(cause)}`;
    } finally {
      busy = false;
    }
  }

  onMount(() => {
    void restore();
  });
</script>

<!-- 忙碌时保留选项焦点，重复提交由 choose 的门禁拒绝。 -->
<fieldset aria-busy={busy} aria-label="阅读字体">
  <legend>阅读字体</legend>
  {#each options as option (option.id)}
    <button
      type="button"
      aria-label={option.label}
      aria-pressed={selected === option.id}
      aria-disabled={busy}
      onclick={() => void choose(option.id)}
    >
      <span class="font-heading"
        ><span>{option.label}</span><span aria-hidden="true"
          >{selected === option.id ? "✓" : ""}</span
        ></span
      >
      <span class="font-sample" style:font-family={option.family}>Reading，让思考慢下来</span>
      <span class="font-description">{option.description}</span>
    </button>
  {/each}
</fieldset>
{#if error}<p class="font-error" role="alert">{error}</p>{/if}

<style>
  fieldset {
    margin: 0.35rem 0 0;
    padding: 0.35rem 0 0;
    border: 0;
    border-top: 1px solid var(--border);
    min-width: 0;
    width: 17rem;
    max-width: calc(100vw - 3rem);
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
  .font-heading {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    font-weight: 500;
  }
  .font-sample {
    display: block;
    margin-top: 0.25rem;
    font-size: 16px;
    line-height: 1.6;
  }
  .font-description {
    display: block;
    margin-top: 0.15rem;
    color: var(--muted);
    font-size: 0.75rem;
  }
  .font-error {
    color: var(--danger);
    padding: 0 0.65rem;
    font-size: 0.8rem;
    overflow-wrap: anywhere;
  }
</style>
