<script lang="ts">
  /** 常用文字样式平铺，颜色选项归属各自菜单，选区状态由文档读取。 */
  import type { Command, EditorState } from "prosemirror-state";
  import { writingCommands } from "../writing";
  import { readInlineMarkStates, readInlineColors } from "./inline-formatting";
  import FormattingMenu, { type FormattingMenuItem } from "./FormattingMenu.svelte";
  import { textPalette, isTextColor, isHighlightColor } from "../../../shared/markdown/text-style";
  import { setTextColor, setHighlightColor, clearTextStyles } from "../text-style-commands";

  let {
    state,
    onFormat,
    id,
  }: {
    state: EditorState;
    onFormat: (command: Command) => void;
    id: string;
  } = $props();
  const formats = [
    { name: "bold", label: "加粗", text: "B", mark: "strong", shortcut: "B" },
    { name: "italic", label: "斜体", text: "I", mark: "em", shortcut: "I" },
    { name: "underline", label: "下划线", text: "U", mark: "underline", shortcut: "U" },
    { name: "strike", label: "删除线", text: "S", mark: "strike", shortcut: "Shift + X" },
    { name: "code", label: "行内代码", text: "〈〉", mark: "code", shortcut: "`" },
  ] as const;

  const marks = $derived(readInlineMarkStates(state));
  const colors = $derived(readInlineColors(state));
  const colorItems = $derived<FormattingMenuItem[]>([
    {
      kind: "command",
      id: "default",
      label: "默认文字颜色",
      command: setTextColor(null),
      checked: colors.text === null,
      disabled: !setTextColor(null)(state),
    },
    ...Object.entries(textPalette.text).flatMap(([color, entry]): FormattingMenuItem[] =>
      isTextColor(color)
        ? [
            {
              kind: "command",
              id: color,
              label: entry.label,
              command: setTextColor(color),
              checked: colors.text === color,
              disabled: !setTextColor(color)(state),
              swatch: entry,
            },
          ]
        : [],
    ),
  ]);
  const highlightItems = $derived<FormattingMenuItem[]>([
    {
      kind: "command",
      id: "none",
      label: "无高亮",
      command: setHighlightColor(null),
      checked: colors.highlight === null,
      disabled: !setHighlightColor(null)(state),
    },
    ...Object.entries(textPalette.highlight).flatMap(([color, entry]): FormattingMenuItem[] =>
      isHighlightColor(color)
        ? [
            {
              kind: "command",
              id: color,
              label: entry.label,
              command: setHighlightColor(color),
              checked: colors.highlight === color,
              disabled: !setHighlightColor(color)(state),
              swatch: entry,
            },
          ]
        : [],
    ),
  ]);
</script>

<div class="marks" role="group" aria-label="文字样式">
  {#each formats as format (format.name)}
    <button
      class="reader-button"
      type="button"
      aria-label={format.label}
      title={`${format.label}${marks[format.mark] === "mixed" ? " · 部分文字" : ""}（⌘/Ctrl + ${format.shortcut}）`}
      aria-pressed={marks[format.mark]}
      disabled={!writingCommands[format.name](state)}
      onclick={() => onFormat(writingCommands[format.name])}>{format.text}</button
    >
  {/each}
  <FormattingMenu
    id="{id}-text-color"
    label="文字颜色"
    indicator={isTextColor(colors.text) ? textPalette.text[colors.text] : null}
    icon="m6 17 6-13 6 13M8 13h8M5 21h14"
    items={colorItems}
    onCommand={onFormat}
  />
  <FormattingMenu
    id="{id}-highlight"
    label="高亮"
    indicator={isHighlightColor(colors.highlight) ? textPalette.highlight[colors.highlight] : null}
    icon="m9 11 7-7 4 4-7 7M9 11l4 4-3 3-4-4 3-3M4 20h7"
    items={highlightItems}
    onCommand={onFormat}
  />
  <button
    class="reader-button"
    type="button"
    aria-label="清除文字样式"
    title="清除文字样式"
    disabled={!clearTextStyles(state)}
    onclick={() => onFormat(clearTextStyles)}
  >
    <svg class="reader-icon" viewBox="0 0 24 24" aria-hidden="true"
      ><path d="m10 4 10 8-7 8H8l-6-5 8-11M6 10l10 8M13 20h8" /></svg
    >
  </button>
</div>

<style>
  .marks {
    display: flex;
    gap: 2px;
  }
  button {
    position: relative;
    flex: 0 0 30px;
    min-width: 30px;
    min-height: 30px;
    height: 30px;
    padding: 0 0.3rem;
    font-size: 15px;
    border-color: transparent;
    background: transparent;
  }
  button[aria-pressed="mixed"]::after {
    content: "";
    position: absolute;
    bottom: 0.1rem;
    left: calc(50% - 0.2rem);
    width: 0.4rem;
    height: 2px;
    border-radius: 1px;
    background: var(--accent);
  }
  button[aria-label="加粗"] {
    font-weight: 700;
  }
  button[aria-label="斜体"] {
    font-family: Georgia, serif;
    font-style: italic;
  }
  button[aria-label="删除线"] {
    text-decoration: line-through;
  }
  button[aria-label="下划线"] {
    text-decoration: underline;
    text-underline-offset: 3px;
  }
</style>
