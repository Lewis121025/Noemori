<script lang="ts">
  /**
   * 歧义链接候选选择：同名多候选不静默取一，由用户决定跳转目标。
   * Esc 或取消关闭时不打开任何目标；选择后由工作区继续锚点定位。
   */
  import { onMount } from "svelte";

  let {
    paths,
    anchor,
    onChoose,
    onDismiss,
  }: {
    /** 候选库内路径（升序）。 */
    paths: string[];
    /** 锚点原文；选择候选后继续生效。 */
    anchor: string | null;
    /** 打开选中的候选。 */
    onChoose: (path: string) => void;
    /** 放弃选择。 */
    onDismiss: () => void;
  } = $props();

  let dialog: HTMLDialogElement;

  onMount(() => {
    dialog.showModal();
    dialog.querySelector<HTMLButtonElement>(".candidate")?.focus();
  });

  function basename(path: string): string {
    return path.slice(path.lastIndexOf("/") + 1);
  }
</script>

<dialog
  class="candidate-dialog"
  bind:this={dialog}
  aria-labelledby="link-candidates-title"
  oncancel={(event) => {
    // cancel 触发原生关闭；工作区状态负责卸载本组件，无需再 close。
    event.preventDefault();
    onDismiss();
  }}
>
  <h2 id="link-candidates-title">找到多篇同名笔记</h2>
  <p class="hint">
    {anchor === null ? "选择要跳转的目标：" : `选择要跳转的目标（标题锚点：${anchor}）：`}
  </p>
  <ul>
    {#each paths as path (path)}
      <li>
        <button type="button" class="candidate" onclick={() => onChoose(path)}>
          <span class="name">{basename(path)}</span>
          <span class="path">{path}</span>
        </button>
      </li>
    {/each}
  </ul>
  <div class="actions">
    <button class="reader-button" type="button" onclick={onDismiss}>取消</button>
  </div>
</dialog>

<style>
  .candidate-dialog {
    width: min(26rem, calc(100vw - 2rem));
    padding: 1.5rem;
    color: var(--fg);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 1rem;
    box-shadow:
      0 8px 24px var(--shadow),
      0 24px 80px var(--shadow);
  }
  .candidate-dialog::backdrop {
    background: var(--scrim);
    backdrop-filter: blur(3px);
  }
  h2 {
    font-size: 1.15rem;
    font-weight: 600;
    margin: 0 0 0.5rem;
  }
  .hint {
    font-size: 0.85rem;
    color: var(--muted);
    margin: 0 0 0.75rem;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    max-height: min(50vh, 24rem);
    overflow: auto;
  }
  .candidate {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    width: 100%;
    padding: 0.5rem 0.65rem;
    font: inherit;
    color: inherit;
    text-align: left;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 0.5rem;
    cursor: pointer;
  }
  .candidate:hover {
    background: var(--selected);
  }
  .candidate:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .name {
    font-weight: 500;
    font-size: 0.9rem;
  }
  .path {
    font-size: 0.72rem;
    color: var(--muted);
    overflow-wrap: anywhere;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    margin-top: 1rem;
  }
  .actions button {
    min-width: 5rem;
  }
</style>
