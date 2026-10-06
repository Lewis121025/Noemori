<script lang="ts">
  /** 两个格式入口共用命令、可用性与选中状态，避免按钮行为分叉。 */
  import type { Command, EditorState } from "prosemirror-state";
  import { writingCommands } from "../writing";
  import { readInlineMarkStates } from "./inline-formatting";

  let {
    state,
    onFormat,
    variant = "all",
  }: {
    state: EditorState;
    onFormat: (command: Command) => void;
    variant?: "all" | "primary" | "secondary";
  } = $props();
  const formats = [
    { name: "bold", label: "加粗", text: "B", mark: "strong", shortcut: "B" },
    { name: "italic", label: "斜体", text: "I", mark: "em", shortcut: "I" },
    { name: "strike", label: "删除线", text: "S", mark: "strike", shortcut: "Shift + X" },
    { name: "highlight", label: "高亮", text: "H", mark: "highlight", shortcut: "Shift + H" },
    { name: "code", label: "行内代码", text: "〈〉", mark: "code", shortcut: "`" },
  ] as const;

  const visibleFormats = $derived(
    formats.filter(
      (format) =>
        variant === "all" ||
        (variant === "primary") === ["bold", "italic", "highlight"].includes(format.name),
    ),
  );
  const marks = $derived(readInlineMarkStates(state));
</script>

<div class="marks" role="group" aria-label="文字样式">
  {#each visibleFormats as format (format.name)}
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
</div>

<style>
  .marks {
    display: flex;
    gap: 0.2rem;
  }
  button {
    position: relative;
    flex: 1;
    min-width: 2rem;
    height: 2rem;
    padding: 0 0.3rem;
    font-size: 1rem;
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
  button[aria-label="高亮"][aria-pressed="true"] {
    background: light-dark(#fff3a3, #5c4a12);
  }
</style>
