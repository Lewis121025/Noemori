<script lang="ts">
  import { tick } from "svelte";
  import type { AgentApi, AgentConversation } from "../shared/api";
  import { createCompositionGuard } from "../../reader/shared/composition";
  let { api, onCreated }: { api: AgentApi; onCreated: (item: AgentConversation) => void } =
    $props();
  let dialog: HTMLDialogElement;
  let input: HTMLInputElement;
  let source = $state.raw<AgentConversation | null>(null);
  let title = $state("");
  let afterTurnId = $state("");
  let busy = $state(false);
  let error = $state("");
  const composition = createCompositionGuard();

  /**
   * 打开分叉确认，固定来源身份；取消不创建任何记录或启动模型。
   * @param conversation 用户正在查看的来源会话。
   * @param turnId 指定轮次之后分叉；null 表示当前完整内容。
   * @returns 表单完成焦点交接后兑现。
   * @throws 原生对话框不能打开时拒绝。
   */
  export async function open(
    conversation: AgentConversation,
    turnId: string | null = null,
  ): Promise<void> {
    source = conversation;
    title = `${conversation.title.slice(0, 115)} · 分支`;
    afterTurnId = turnId ?? "";
    error = "";
    dialog.showModal();
    await tick();
    input.focus();
    input.select();
  }
  async function create(): Promise<void> {
    if (!source || busy || composition.active || !title.trim()) return;
    busy = true;
    error = "";
    try {
      const item = await api.fork(source.id, {
        title: title.trim(),
        afterTurnId: afterTurnId || null,
      });
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
  class="fork-conversation-dialog"
  aria-labelledby="fork-conversation-title"
  bind:this={dialog}
  use:composition.bind
  oncancel={(event) => {
    if (busy || composition.active) event.preventDefault();
  }}
>
  <form
    onsubmit={(event) => {
      event.preventDefault();
      void create();
    }}
  >
    <header>
      <h2 id="fork-conversation-title">分叉对话</h2>
    </header>
    <label for="fork-conversation-name">分支名称</label>
    <input
      id="fork-conversation-name"
      class="reader-input"
      bind:this={input}
      bind:value={title}
      maxlength="120"
      disabled={busy}
      autocomplete="off"
    />
    <label for="fork-conversation-turn">分叉位置</label>
    <select
      id="fork-conversation-turn"
      class="reader-input"
      bind:value={afterTurnId}
      disabled={busy}
    >
      <option value="">当前对话的完整内容</option>
      {#each source?.turns ?? [] as turn, index (turn.run.id)}
        {@const message = source?.messages[turn.message_start]?.content.find(
          (part) => part.type === "text",
        )}
        <option value={turn.run.id} disabled={turn.run.status === "running"}
          >第 {index + 1} 轮之后 · {message?.type === "text"
            ? message.value.slice(0, 60)
            : "用户任务"}{turn.run.status === "running" ? "（进行中）" : ""}</option
        >
      {/each}
    </select>
    <div class="source">
      <div class="source-row"><span>来源</span><strong>{source?.title}</strong></div>
      <div class="source-row">
        <span>工作目录</span><code title={source?.workspace}>{source?.workspace}</code>
      </div>
    </div>
    <p class="hint">
      对话独立；目录共享，文件修改互相可见。
    </p>
    {#if source?.run?.status === "running" && afterTurnId === ""}<p class="hint">
        原任务继续运行，分支等待新任务。
      </p>{/if}
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
      <button class="reader-button primary" type="submit" disabled={busy || !title.trim()}
        >{busy ? "正在分叉…" : "创建分支"}</button
      >
    </footer>
  </form>
</dialog>

<style>
  dialog {
    --radius-panel: 16px;
    width: min(32rem, calc(100vw - 2rem));
    max-height: calc(100dvh - 2rem);
    overflow: auto;
    padding: 1.5rem;
    color: var(--fg);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 1rem;
    box-shadow: 0 12px 48px var(--shadow);
  }
  dialog::backdrop {
    background: var(--scrim);
    backdrop-filter: blur(3px);
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
  }
  h2 {
    margin: 0;
    font-size: 18px;
    font-weight: 550;
    line-height: 1.5;
  }
  p {
    margin: 0.3rem 0 0;
    line-height: 1.6;
  }
  label,
  p {
    font-size: 0.8rem;
  }
  label {
    font-weight: 500;
  }
  .hint,
  .source {
    color: var(--muted);
  }
  .source {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    padding: 0.7rem;
    background: var(--sidebar);
    border-radius: 8px;
    font-size: 0.75rem;
    overflow-wrap: anywhere;
  }
  .source-row {
    display: grid;
    grid-template-columns: 4rem minmax(0, 1fr);
    gap: 0.4rem;
  }
  .source-row > span {
    white-space: nowrap;
  }
  .source-row strong {
    font-weight: 400;
    overflow-wrap: anywhere;
  }
  .source-row code {
    display: block;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font: inherit;
  }
  input,
  select {
    min-width: 0;
    width: 100%;
  }
  .error {
    color: var(--danger);
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
  @media (max-height: 600px) {
    dialog {
      padding: 1rem;
    }
    form {
      gap: 0.5rem;
    }
  }
</style>
