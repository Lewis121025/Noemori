<script lang="ts">
  import { tick } from "svelte";
  import type { AgentConversation, AgentApproval, AgentMessage } from "../shared/api";
  import MessageText from "./MessageText.svelte";
  let {
    current,
    openLink,
    approving,
    onApprove,
    onFork,
  }: {
    current: AgentConversation;
    openLink: (url: string) => Promise<void>;
    approving: boolean;
    onFork?: (turnId: string) => void;
    onApprove: (
      approval: AgentApproval,
      decision: "allow_once" | "allow_for_session" | "deny",
    ) => void;
  } = $props();
  let viewport: HTMLDivElement;
  let follow = $state(true);
  let linkedTurn = $state<string | null>(null);
  const roleLabels: Record<AgentMessage["role"], string> = {
    system: "系统",
    user: "你",
    assistant: "助手",
    tool: "工具",
  };
  const endingTurns = $derived(
    new Map(current.turns.map((turn, index) => [turn.message_end - 1, { turn, index }])),
  );

  /** 定位分叉来源轮次；目标不在当前记录中时不改变用户的滚动位置，不抛出异常。 */
  export function focusTurn(id: string): void {
    const target = Array.from(viewport.querySelectorAll<HTMLElement>("[data-turn-id]")).find(
      (node) => node.dataset.turnId === id,
    );
    if (!target) return;
    follow = false;
    linkedTurn = id;
    target.scrollIntoView({ block: "center" });
    target.focus({ preventScroll: true });
  }
  const pending = $derived(current.approvals[0] ?? null);
  $effect(() => {
    void current.revision;
    if (follow)
      void tick().then(() => {
        if (viewport?.isConnected) viewport.scrollTop = viewport.scrollHeight;
      });
  });
  function bottom(): void {
    follow = true;
    viewport.scrollTop = viewport.scrollHeight;
  }
</script>

<div class="message-region">
  <div
    class="messages"
    role="log"
    aria-label="对话消息"
    bind:this={viewport}
    onscroll={() =>
      (follow = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 60)}
  >
    <div class="message-column">
      {#if current.messages.length === 0}<div class="conversation-start">
          <p>发送消息，开始对话。</p>
        </div>{/if}
      {#each current.messages as message, index (index)}
        {#if message.content.length > 0}<article
            class:user={message.role === "user"}
            class:tool={message.role === "tool"}
            aria-label={roleLabels[message.role]}
          >
            {#each message.content as part, partIndex (partIndex)}
              {#if part.type === "text"}{#if message.role === "user"}<div class="user-text">
                    {part.value}
                  </div>{:else}<MessageText text={part.value} {openLink} />{/if}
              {:else if part.type === "reasoning"}<details>
                  <summary>思考过程</summary>
                  <div class="reasoning">{part.value}</div>
                </details>
              {:else if part.type === "tool_call"}<details class="tool-call">
                  <summary
                    >{part.value.name === "terminal"
                      ? "执行终端任务"
                      : part.value.name === "browser"
                        ? "操作浏览器"
                        : part.value.name === "ui_repl"
                          ? "操作浏览器与桌面"
                          : part.value.name}</summary
                  >
                  <pre>{JSON.stringify(part.value.arguments, null, 2)}</pre>
                </details>
              {:else if part.type === "tool_result"}<details open={part.value.is_error}>
                  <summary class:error={part.value.is_error}
                    >{part.value.is_error ? "操作未完成" : "操作结果"}</summary
                  >
                  <pre>{JSON.stringify(part.value.output, null, 2)}</pre>
                </details>{/if}
            {/each}
          </article>{/if}
        {@const ended = endingTurns.get(index)}
        {#if ended}<div
            class="turn-actions"
            class:linked={linkedTurn === ended.turn.run.id}
            data-turn-id={ended.turn.run.id}
            tabindex="-1"
          >
            <span class="turn-number">第 {ended.index + 1} 轮</span>
            {#if onFork && ended.turn.run.status !== "running"}<button
                class="reader-button"
                type="button"
                aria-label="从此轮分叉"
                title={`从第 ${ended.index + 1} 轮分叉`}
                onclick={() => onFork?.(ended.turn.run.id)}
                ><svg viewBox="0 0 20 20" aria-hidden="true"
                  ><circle cx="6" cy="4" r="2" /><circle cx="6" cy="16" r="2" /><circle
                    cx="15"
                    cy="5"
                    r="2"
                  /><path d="M6 6v8m0-4h4a5 5 0 0 0 5-3" /></svg
                ></button
              >{/if}
          </div>{/if}
      {/each}
      {#if current.run?.status === "running"}<p class="run-status" role="status">
          助手正在处理<span class="activity">…</span>
        </p>{/if}
      {#if pending}<section class="approval" aria-label="权限审批">
          <h3>
            {pending.request.type === "browser"
              ? "允许访问这个网站？"
              : pending.request.type === "ui"
                ? "允许在后台操作这个窗口？"
                : pending.request.type === "network"
                  ? "允许这次网络访问？"
                  : "任务需要额外权限"}
          </h3>
          {#if pending.request.type === "browser"}<p>{pending.request.request.reason}</p>
            <code>{pending.request.request.origin}</code>
          {:else if pending.request.type === "ui"}<p>
              {pending.request.request.app_name} · {pending.request.request.window_title}
            </p>
            <p>{pending.request.request.reason}</p>
            <p>你操作键盘、鼠标或切换窗口时，助手会暂停。</p>
          {:else if pending.request.type === "network"}<p>
              {pending.request.request.target.host}:{pending.request.request.target.port} · {pending
                .request.request.target.protocol}
            </p>
            <pre>{pending.request.request.command}</pre>
          {:else}<p>{pending.request.request.permissions.reason}</p>
            <pre>{pending.request.request.command}</pre>
            <p>目录：{pending.request.request.workdir}</p>
            {#each pending.request.request.permissions.readable_paths as path (path)}<p>
                读取：{path}
              </p>{/each}
            {#each pending.request.request.permissions.writable_paths as path (path)}<p>
                读写：{path}
              </p>{/each}
            {#if pending.request.request.permissions.network}<p>需要网络访问。</p>{/if}
          {/if}
          <div class="approval-actions">
            <button
              class="reader-button"
              type="button"
              disabled={approving}
              onclick={() => onApprove(pending, "deny")}>拒绝</button
            >
            {#if pending.request.type !== "browser" && pending.request.type !== "ui"}<button
                class="reader-button"
                type="button"
                disabled={approving}
                onclick={() => onApprove(pending, "allow_once")}>批准本次</button
              >{/if}
            <button
              class="reader-button primary"
              type="button"
              disabled={approving}
              onclick={() => onApprove(pending, "allow_for_session")}>此会话允许</button
            >
          </div>
        </section>{/if}
    </div>
  </div>
  {#if !follow}<button class="reader-button latest" type="button" onclick={bottom}
      >↓ 回到最新消息</button
    >{/if}
</div>

<style>
  .turn-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: -10px 0 24px;
    color: var(--muted);
    font-size: 0.68rem;
    border-radius: 6px;
  }
  .turn-actions button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--muted);
    box-shadow: none;
  }
  .turn-actions button:hover {
    background: var(--selected);
    color: var(--fg);
  }
  .turn-actions svg {
    width: 15px;
    height: 15px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
  }
  .turn-number {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
  .turn-actions.linked {
    outline: 1px solid var(--accent);
    outline-offset: 4px;
  }
  .message-region {
    position: relative;
    display: flex;
    flex: 1;
    min-height: 0;
  }
  .messages {
    flex: 1;
    min-height: 0;
    overflow: auto;
    overscroll-behavior: contain;
  }
  .message-column {
    max-width: 48rem;
    margin: 0 auto;
    padding: 24px 20px;
  }
  article {
    margin-bottom: 24px;
    min-width: 0;
  }
  .user {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    margin-left: 8%;
  }
  .user-text {
    background: var(--sidebar);
    max-width: 100%;
    padding: 10px 13px;
    border-radius: 12px 12px 3px 12px;
    font-size: 0.88rem;
    line-height: 1.7;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .tool {
    margin: -0.6rem 0 1rem;
  }
  details {
    margin: 0.5rem 0;
    padding: 4px 0;
    color: var(--muted);
    font-size: 0.76rem;
  }
  summary {
    cursor: pointer;
  }
  pre {
    max-height: 20rem;
    overflow: auto;
    font-size: 0.72rem;
    line-height: 1.6;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .reasoning {
    margin-top: 0.7rem;
    line-height: 1.7;
    white-space: pre-wrap;
  }
  .conversation-start {
    margin: 5vh 0;
  }
  .conversation-start p {
    font-size: 0.86rem;
    line-height: 1.8;
    color: var(--muted);
    max-width: 30rem;
  }
  .run-status {
    color: var(--accent);
    font-size: 0.8rem;
  }
  .approval {
    padding: 1rem;
    border: 1px solid var(--accent);
    border-radius: 10px;
    background: var(--sidebar);
    font-size: 0.8rem;
    overflow-wrap: anywhere;
  }
  .approval h3 {
    font-size: 0.95rem;
    margin-top: 0;
  }
  .approval-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    justify-content: flex-end;
  }
  .latest {
    position: absolute;
    bottom: 0.75rem;
    left: 50%;
    transform: translateX(-50%);
    background: var(--bg);
    box-shadow: 0 3px 12px var(--shadow);
    white-space: nowrap;
  }
  .error {
    color: var(--danger);
  }
  @media (max-width: 700px) {
    .message-column {
      padding: 1rem;
    }
    .user {
      margin-left: 5%;
    }
  }
</style>
