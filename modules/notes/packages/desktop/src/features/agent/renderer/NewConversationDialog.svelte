<script lang="ts">
  import { tick } from "svelte";
  import type { AgentApi, AgentConversation } from "../shared/api";
  import { createCompositionGuard } from "../../reader/shared/composition";
  let {
    api,
    workspaces,
    onCreated,
  }: { api: AgentApi; workspaces: string[]; onCreated: (item: AgentConversation) => void } =
    $props();
  let dialog: HTMLDialogElement;
  let input: HTMLInputElement;
  let title = $state("新对话");
  let workspace = $state("");
  let busy = $state(false);
  let picking = $state(false);
  let error = $state("");
  const composition = createCompositionGuard();

  /** 打开尚未创建的会话表单；目录关联可选，取消不会启动模型或写入会话。 */
  export async function open(initialWorkspace: string | null = null): Promise<void> {
    title = "新对话";
    workspace = initialWorkspace ?? "";
    error = "";
    dialog.showModal();
    await tick();
    input.focus();
    input.select();
  }
  async function pick(): Promise<void> {
    picking = true;
    error = "";
    try {
      const selected = await api.pickWorkspace();
      if (selected) workspace = selected;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      picking = false;
    }
  }
  async function create(): Promise<void> {
    if (busy || picking || composition.active || !title.trim()) return;
    busy = true;
    error = "";
    try {
      const item = await api.create(workspace || null, title.trim());
      dialog.close();
      onCreated(item);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }
</script>

<dialog
  class="new-conversation-dialog"
  aria-labelledby="new-conversation-title"
  bind:this={dialog}
  use:composition.bind
  oncancel={(event) => {
    if (busy || picking || composition.active) event.preventDefault();
  }}
>
  <form
    onsubmit={(event) => {
      event.preventDefault();
      void create();
    }}
  >
    <header>
      <h2 id="new-conversation-title">新建对话</h2>
      <p>可以直接创建，也可以关联文件夹。</p>
    </header>
    <label for="conversation-title">会话名称</label>
    <input
      class="reader-input"
      id="conversation-title"
      bind:this={input}
      bind:value={title}
      maxlength="120"
      autocomplete="off"
      disabled={busy}
    />
    {#if workspaces.length > 0}<label for="conversation-workspace">关联目录（可选）</label>
      <select
        class="reader-input"
        id="conversation-workspace"
        aria-label="关联目录"
        bind:value={workspace}
        disabled={busy || picking}
      >
        <option value="">不关联目录</option>
        {#each [...new Set( [...workspaces, ...(workspace ? [workspace] : [])] )] as path (path)}<option
            value={path}>{path}</option
          >{/each}
      </select>
    {:else if workspace}<p class="linked-folder" title={workspace}>{workspace}</p>{/if}
    <button
      class="reader-button choose-folder"
      type="button"
      disabled={busy || picking}
      onclick={() => void pick()}
      >{picking ? "正在选择…" : workspace ? "更换关联文件夹…" : "关联文件夹…"}</button
    >
    {#if workspace}<button
        class="reader-button"
        type="button"
        disabled={busy || picking}
        onclick={() => (workspace = "")}>取消目录关联</button
      >
      <p class="hint">关联后，助手可在这个文件夹中工作。</p>{/if}
    {#if error}<p role="alert" class="error">{error}</p>{/if}
    <footer>
      <button
        class="reader-button"
        type="button"
        disabled={busy || picking}
        onclick={() => {
          if (!composition.active) dialog.close();
        }}>取消</button
      >
      <button
        class="reader-button primary"
        type="submit"
        disabled={busy || picking || !title.trim()}>{busy ? "正在创建…" : "创建对话"}</button
      >
    </footer>
  </form>
</dialog>

<style>
  dialog {
    width: min(30rem, calc(100vw - 2rem));
    max-height: calc(100dvh - 2rem);
    overflow: auto;
    color: var(--fg);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 1rem;
    padding: 1.5rem;
    box-shadow: 0 12px 48px var(--shadow);
  }
  dialog::backdrop {
    background: var(--scrim);
    backdrop-filter: blur(3px);
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
  }
  h2 {
    margin: 0;
    font-size: 1.2rem;
  }
  header p,
  .hint {
    color: var(--muted);
    font-size: 0.8rem;
    line-height: 1.6;
  }
  label {
    font-size: 0.8rem;
  }
  .choose-folder {
    align-self: flex-start;
  }
  .linked-folder {
    font-size: 0.8rem;
    overflow-wrap: anywhere;
    margin: 0;
  }
  .error {
    color: var(--danger);
    font-size: 0.8rem;
  }
  footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }
</style>
