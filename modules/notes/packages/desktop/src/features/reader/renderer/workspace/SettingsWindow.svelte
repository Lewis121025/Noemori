<script lang="ts">
  import type { Snippet } from "svelte";
  import { selectionIndicator } from "../selection-indicator";
  import type { ReaderWorkspaceController } from "./state.svelte";
  import { READER_COMMANDS, shortcutLabel } from "../../shared/commands";
  let {
    workspace,
    preferences,
    onOpenVault,
  }: {
    workspace: ReaderWorkspaceController;
    preferences: Snippet;
    onOpenVault: () => Promise<void>;
  } = $props();
  let dialog: HTMLDialogElement;
  let returnFocus: HTMLElement | null = null;
  let section = $state<"appearance" | "vault" | "shortcuts">("appearance");
  const mac = navigator.userAgent.includes("Mac");

  /**
   * 打开唯一设置窗口，并保留原操作位置。
   * @returns 无返回值；重复打开只将焦点交回现有窗口。
   * @throws 原生对话框打开失败时保留浏览器异常。
   */
  export function open(): void {
    if (!dialog.open) {
      returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
    }
    dialog.querySelector<HTMLButtonElement>(".close-settings")?.focus();
  }
</script>

<dialog
  class="settings-window"
  aria-labelledby="settings-title"
  bind:this={dialog}
  onclose={() => {
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  }}
>
  <header>
    <h1 id="settings-title">设置</h1>
    <button
      class="reader-button icon-button close-settings"
      type="button"
      aria-label="关闭设置"
      title="关闭设置（Esc）"
      onclick={() => dialog.close()}>×</button
    >
  </header>
  <div class="settings-body">
    <nav aria-label="设置分类" use:selectionIndicator={section}>
      <button
        type="button"
        class="reader-button"
        aria-pressed={section === "appearance"}
        onclick={() => (section = "appearance")}>外观与阅读</button
      >
      <button
        type="button"
        class="reader-button"
        aria-pressed={section === "vault"}
        onclick={() => (section = "vault")}>笔记库</button
      >
      <button
        type="button"
        class="reader-button"
        aria-pressed={section === "shortcuts"}
        onclick={() => (section = "shortcuts")}>快捷键</button
      >
    </nav>
    <div class="settings-content">
      <section data-motion="reveal" hidden={section !== "appearance"} aria-label="外观与阅读设置">
        {@render preferences()}
      </section>
      <section data-motion="reveal" hidden={section !== "vault"} aria-label="笔记库设置">
        <h2>当前笔记库</h2>
        <p class="vault-path">{workspace.vaultRoot ?? "尚未打开笔记库"}</p>
        <button
          class="reader-button primary"
          type="button"
          disabled={workspace.switching || workspace.copying || workspace.isComposing}
          onclick={() => void onOpenVault()}>打开笔记库…</button
        >
        <p class="hint">笔记和附件保存在本地文件夹中。切换笔记库前会先保存当前编辑。</p>
        {#if workspace.messageNeedsAttention}<p class="settings-error" role="alert">
            {workspace.message}
          </p>{/if}
      </section>
      <section data-motion="reveal" hidden={section !== "shortcuts"} aria-label="快捷键说明">
        <h2>常用快捷键</h2>
        <dl>
          {#each READER_COMMANDS.filter((command) => command.shortcut !== null) as command (command.id)}<div
            >
              <dt>{command.label}</dt>
              <dd><kbd>{shortcutLabel(command.shortcut, mac)}</kbd></dd>
            </div>{/each}
        </dl>
      </section>
    </div>
  </div>
</dialog>

<style>
  .settings-window {
    width: min(44rem, calc(100vw - 3rem));
    max-width: none;
    height: min(36rem, calc(100vh - 3rem));
    max-height: none;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--bg);
    color: var(--fg);
    box-shadow: var(--shadow-popover);
    overflow: hidden;
  }
  .settings-window::backdrop {
    background: var(--scrim);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 54px;
    padding: 0 18px;
    border-bottom: 1px solid var(--border);
  }
  h1 {
    font-size: 1rem;
    margin: 0;
    font-weight: 600;
  }
  h2 {
    font-size: 0.95rem;
    margin: 0 0 1rem;
  }
  .settings-body {
    display: grid;
    grid-template-columns: 9rem minmax(0, 1fr);
    height: calc(100% - 54px);
  }
  nav {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 12px 8px;
    background: var(--sidebar);
    border-right: 1px solid var(--border);
  }
  nav button {
    text-align: left;
  }
  .settings-content {
    display: grid;
    overflow: hidden;
    min-width: 0;
    min-height: 0;
  }
  .settings-content > section {
    /* 分类各自拥有滚动区，切换不会继承另一页的半页偏移。 */
    overflow: auto;
    min-height: 0;
    scrollbar-gutter: stable;
    padding: 22px;
  }
  section[hidden] {
    display: none;
  }
  .vault-path {
    overflow-wrap: anywhere;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface);
  }
  .hint {
    font-size: 0.8rem;
    color: var(--muted);
    line-height: 1.6;
  }
  .settings-error {
    color: var(--danger);
  }
  dl {
    margin: 0;
    font-size: 0.8rem;
  }
  dl > div {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.6rem 0;
    border-bottom: 1px solid var(--border);
  }
  dd {
    margin: 0;
    white-space: nowrap;
    color: var(--muted);
  }
  @media (max-width: 700px) {
    .settings-body {
      grid-template-columns: 7rem minmax(0, 1fr);
    }
    .settings-content > section {
      padding: 14px;
    }
  }
</style>
