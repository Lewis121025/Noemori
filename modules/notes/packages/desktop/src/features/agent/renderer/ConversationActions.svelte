<script module lang="ts">
  /** 会话管理动作的确认范围；恢复归档是可逆的直接操作。 */
  export type ConversationAction = "rename" | "archive" | "remove";
</script>

<script lang="ts">
  import { tick } from "svelte";
  import type { AgentApi, AgentConversation } from "../shared/api";
  import { createCompositionGuard } from "../../reader/shared/composition";
  let { api, onDone }: { api: AgentApi; onDone: (action: ConversationAction, id: string) => void } =
    $props();
  let dialog: HTMLDialogElement;
  let input: HTMLInputElement | undefined = $state();
  let item = $state<AgentConversation | null>(null);
  let action = $state<ConversationAction>("rename");
  let name = $state("");
  let busy = $state(false);
  let error = $state("");
  const composition = createCompositionGuard();
  const title = $derived(
    action === "rename" ? "重命名对话" : action === "archive" ? "归档对话" : "删除对话",
  );
  /** 捕获当前对话身份，列表更新或其他会话运行不会改变确认目标。 */
  export async function open(
    next: ConversationAction,
    conversation: AgentConversation,
  ): Promise<void> {
    item = conversation;
    action = next;
    name = conversation.title;
    error = "";
    dialog.showModal();
    await tick();
    input?.focus();
    input?.select();
  }
  async function submit(): Promise<void> {
    if (!item || busy || composition.active || (action === "rename" && !name.trim())) return;
    const id = item.id;
    busy = true;
    error = "";
    try {
      if (action === "rename") await api.rename(id, name);
      else if (action === "archive") await api.archive(id, true);
      else await api.remove(id);
      dialog.close();
      onDone(action, id);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }
</script>

<dialog
  class="conversation-action-dialog"
  aria-labelledby="conversation-action-title"
  bind:this={dialog}
  use:composition.bind
  oncancel={(event) => {
    if (busy || composition.active) event.preventDefault();
  }}
>
  <form
    onsubmit={(event) => {
      event.preventDefault();
      void submit();
    }}
  >
    <h2 id="conversation-action-title">{title}</h2>
    {#if action === "rename"}<label for="rename-conversation">会话名称</label><input
        class="reader-input"
        id="rename-conversation"
        bind:this={input}
        bind:value={name}
        maxlength="120"
        disabled={busy}
      />
    {:else}<p>「{item?.title}」</p>
      <p class="hint">
        {action === "archive"
          ? "归档后可恢复。"
          : "删除后无法恢复，工作目录文件保留。"}
      </p>
      {#if item?.run?.status === "running" || item?.terminals.some((entry) => entry.process.status === "running")}<p
          class="hint"
        >
          正在执行的任务和终端将停止。
        </p>{/if}
    {/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <footer>
      <button
        class="reader-button"
        type="button"
        disabled={busy}
        onclick={() => {
          if (!composition.active) dialog.close();
        }}>取消</button
      >
      <button
        class="reader-button primary"
        class:danger={action === "remove"}
        type="submit"
        disabled={busy || (action === "rename" && !name.trim())}
        >{busy ? "处理中…" : action === "rename" ? "保存名称" : title}</button
      >
    </footer>
  </form>
</dialog>

<style>
  dialog {
    --radius-panel: 16px;
    width: min(27rem, calc(100vw - 2rem));
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
    gap: 0.8rem;
  }
  h2 {
    margin: 0;
    font-size: 18px;
    font-weight: 550;
    line-height: 1.5;
  }
  p {
    margin: 0;
    line-height: 1.6;
    overflow-wrap: anywhere;
  }
  label,
  .hint {
    font-size: 13px;
    color: var(--muted);
  }
  .error {
    color: var(--danger);
    font-size: 0.8rem;
  }
  footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.75rem;
  }
  footer button {
    min-height: 34px;
    font-size: 12px;
  }
  .danger {
    --accent: var(--danger);
    --accent-fill: var(--danger);
    --accent-text: light-dark(#ffffff, #391c15);
  }
</style>
