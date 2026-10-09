<script lang="ts">
  import { onMount, tick } from "svelte";
  import type { AgentConversation, AgentApproval, AgentMessage, AgentTurn } from "../shared/api";
  import ReferenceCards from "./ReferenceCards.svelte";
  import type { AgentReference } from "../shared/references";
  import { readConversationInput } from "../shared/input";
  import AttachmentCards from "./AttachmentCards.svelte";
  import type { AgentApi } from "../shared/api";
  import MessageText from "./MessageText.svelte";
  import CopyButton from "./CopyButton.svelte";
  import ApprovalCard from "./ApprovalCard.svelte";
  import ToolMessage from "./ToolMessage.svelte";
  import { pairToolResults, toolAction, type ToolCall } from "../shared/tool-presentation";
  let {
    current,
    openLink,
    approving,
    onApprove,
    onFork,
    onSuggest,
    api,
    onOpenReference,
  }: {
    current: AgentConversation;
    api?: AgentApi;
    openLink: (url: string) => Promise<void>;
    approving: boolean;
    onFork?: (turnId: string) => void;
    onOpenReference?: (reference: AgentReference) => Promise<void>;
    onSuggest?: ((prompt: string) => void) | undefined;
    onApprove: (
      approval: AgentApproval,
      decision: "allow_once" | "allow_for_session" | "deny",
    ) => void;
  } = $props();
  let viewport: HTMLDivElement;
  let column: HTMLDivElement;
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
  const toolResults = $derived(pairToolResults(current.messages));
  const activeStart = $derived(current.turns.find((turn) => turn.run.id === current.run?.id)?.message_start
    ?? current.messages.findLastIndex((message) => message.role === "user" || message.role === "assistant"));
  const toolTargets = $derived(new Map([
    ...current.browser.tabs.map((tab) => [`managed:${tab.id}`, tab.title || tab.url] as const),
    ...current.ui.connections.flatMap((connection) => connection.tabs.map((tab) => [`${connection.backend}:${tab.id}`, tab.title || tab.url] as const)),
    ...(current.ui.control ? [[`computer:${current.ui.control.app}:${current.ui.control.window}`, `${current.ui.control.app_name} · ${current.ui.control.window_title}`] as const] : []),
  ]));
  function terminalFor(call: ToolCall) {
    if (call.name !== "terminal") return undefined;
    const args = call.arguments;
    const session = args !== null && typeof args === "object" && "session_id" in args && typeof args.session_id === "string" ? args.session_id : null;
    return current.terminals.find((terminal) => terminal.call_id === call.id || terminal.process.session_id === session);
  }
  const lastPart = $derived(current.messages.at(-1)?.content.at(-1));
  const activityLabel = $derived(
    pending
      ? "等待你的确认"
      : lastPart?.type === "reasoning"
        ? "正在思考"
        : lastPart?.type === "tool_call"
          ? `正在${toolAction(lastPart.value).label}`
          : lastPart?.type === "text" && current.messages.at(-1)?.role === "assistant"
            ? "正在生成回复"
            : "正在处理任务",
  );
  const suggestions = [
    {
      title: "整理思路",
      description: "把零散想法梳理清楚",
      prompt: "我想整理一些思路。请先问我想讨论的主题，再帮我梳理成清晰的提纲。",
    },
    {
      title: "比较资料",
      description: "找到差异与值得关注的线索",
      prompt: "我想比较几份资料。请先问我要比较的内容和关注点，再帮我整理共同点、差异和结论。",
    },
    {
      title: "制定计划",
      description: "把目标拆成可以开始的步骤",
      prompt: "帮我制定一个可执行的计划。请先了解我的目标、时间和限制，再一起确定步骤。",
    },
  ];
  function messageText(message: AgentMessage): string {
    const raw = message.content
      .flatMap((part) => (part.type === "text" ? [part.value] : []))
      .join("\n\n");
    if (message.role !== "user") return raw;
    const input = readConversationInput(raw);
    return [input.text, ...input.references.map((reference) =>
      `引用：${reference.source?.path ?? "选中文字"}\n${reference.text}`), ...input.attachments.map((file) => `附件：${file.name}`)].filter(Boolean).join("\n\n");
  }
  function followLatest(): void {
    void tick().then(() => {
      if (follow && viewport?.isConnected) viewport.scrollTop = viewport.scrollHeight;
    });
  }
  onMount(() => {
    const observer = new ResizeObserver(() => {
      if (follow) followLatest();
    });
    observer.observe(viewport);
    observer.observe(column);
    return () => observer.disconnect();
  });
  $effect(() => {
    void current.revision;
    if (follow) followLatest();
  });
  /**
   * 用户发送新任务或选择回到最新时恢复跟随；滚动到历史后不会被流式更新拉走。
   * @returns 无返回值；尚未挂载时只记录跟随意图，不抛出异常。
   */
  export function showLatest(): void {
    follow = true;
    if (viewport?.isConnected) viewport.scrollTop = viewport.scrollHeight;
  }
</script>

{#snippet branchAction(ended: { turn: AgentTurn; index: number })}
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
{/snippet}

<div class="message-region">
  <span class="message-announcement" role="status">
    {current.run?.status === "completed" ? "助手已回复" : ""}
  </span>
  <div class="message-viewport">
    <div
      class="messages"
      role="log"
      aria-label="对话消息"
      aria-live="off"
      bind:this={viewport}
      onscroll={() =>
        (follow = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 60)}
    >
      <div class="message-column" class:empty={current.messages.length === 0} bind:this={column}>
        {#if current.messages.length === 0 && current.run?.status !== "running"}<div
            class="conversation-start"
          >
            <h2>{current.archived ? "此对话没有消息" : "有什么想法？"}</h2>
            {#if onSuggest}<div class="suggestions" aria-label="开始对话的建议">
                {#each suggestions as suggestion, index (suggestion.title)}<button
                    type="button"
                    aria-label={suggestion.title}
                    title={suggestion.description}
                    onclick={() => onSuggest?.(suggestion.prompt)}
                    ><svg viewBox="0 0 20 20" aria-hidden="true">
                      {#if index === 0}<path d="M5 5h10M5 10h10M5 15h6" />
                      {:else if index === 1}<path d="M4 4h5v12H4zM12 4h4v12h-4z" />
                      {:else}<rect x="4" y="3" width="12" height="14" rx="2" /><path
                          d="m7 10 2 2 4-4"
                        />{/if}
                    </svg><span>{suggestion.title}</span><svg
                      class="suggestion-arrow"
                      viewBox="0 0 20 20"
                      aria-hidden="true"><path d="M4 10h12m-5-5 5 5-5 5" /></svg
                    >
                  </button>{/each}
              </div>{/if}
          </div>{/if}
        {#each current.messages as message, index (index)}
          {@const content = message.content.filter((part) => part.type !== "tool_result" || toolResults.get(part.value.call_id) !== part.value)}
          {@const copyText =
            message.role === "user" || message.role === "assistant" ? messageText(message) : ""}
          {@const ended = endingTurns.get(index)}
          {#if content.length > 0}<article
              class:user={message.role === "user"}
              class:tool={message.role === "tool"}
              aria-label={roleLabels[message.role]}
            >
              {#each content as part, partIndex (partIndex)}
                {#if part.type === "text"}{#if message.role === "user"}{@const input = readConversationInput(part.value)}<div class="user-text">
                      {#if input.references.length}<ReferenceCards references={input.references} {...onOpenReference ? { onOpen: onOpenReference } : {}} />{/if}
                      {#if input.attachments.length && api}<AttachmentCards {api} session={current.id} files={input.attachments} />{/if}
                      {input.text}
                    </div>{:else}<MessageText text={part.value} {openLink} />{/if}
                {:else if part.type === "reasoning"}<details class="reasoning-block">
                    <summary><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m7 5 5 5-5 5" /></svg>思考过程</summary>
                    <div class="reasoning">
                      <div class="reasoning-actions"><CopyButton text={part.value} label="复制思考过程" iconOnly /></div>
                      <MessageText text={part.value} {openLink} />
                    </div>
                  </details>
                {:else if part.type === "tool_call"}<ToolMessage call={part.value} result={toolResults.get(part.value.id)} running={current.run?.status === "running" && index >= activeStart} {api} session={current.id} terminal={terminalFor(part.value)} targets={toolTargets} />
                {:else if part.type === "tool_result"}<ToolMessage call={undefined} result={part.value} running={false} />{/if}
              {/each}
              {#if copyText || ended}
                <div
                  class="message-actions"
                  class:turn-actions={Boolean(ended)}
                  class:linked={Boolean(ended && linkedTurn === ended.turn.run.id)}
                  data-turn-id={ended?.turn.run.id}
                  tabindex="-1"
                >
                  {#if copyText}<CopyButton text={copyText} label="复制消息" iconOnly />{/if}
                  {#if ended}{@render branchAction(ended)}{/if}
                </div>
              {/if}
            </article>
          {:else if ended}<div
              class="turn-actions"
              class:linked={linkedTurn === ended.turn.run.id}
              data-turn-id={ended.turn.run.id}
              tabindex="-1"
            >
              {@render branchAction(ended)}
            </div>{/if}
        {/each}
        {#if current.run?.status === "running"}<p class="run-status" role="status">
            <span class="run-indicator" class:waiting={pending !== null} aria-hidden="true"
            ></span>{activityLabel}
          </p>{/if}
      </div>
    </div>
    {#if !follow}<button class="reader-button latest" type="button" onclick={showLatest}
        >↓ 回到最新消息</button
      >{/if}
  </div>
  {#if pending}<ApprovalCard
      {pending}
      count={current.approvals.length}
      {approving}
      {onApprove}
    />{/if}
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
    border-radius: var(--radius-control);
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
  .message-actions.turn-actions {
    margin: 4px 0 0;
    gap: 4px;
  }
  .turn-number,
  .message-announcement {
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
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    min-width: 0;
  }
  .message-viewport {
    position: relative;
    display: flex;
    flex: 1;
    min-height: 0;
    min-width: 0;
  }
  .messages {
    flex: 1;
    min-height: 0;
    min-width: 0;
    overflow: auto;
    overscroll-behavior: contain;
    scrollbar-gutter: stable;
  }
  .message-column {
    max-width: var(--conversation-width, 44rem);
    margin: 0 auto;
    padding: 24px var(--conversation-inset, 20px);
  }
  .message-column.empty {
    display: flex;
    flex-direction: column;
    min-height: 100%;
    box-sizing: border-box;
  }
  article {
    margin-bottom: 28px;
    min-width: 0;
  }
  .message-column > article:last-child {
    margin-bottom: 0;
  }
  .user {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    margin-left: 8%;
  }
  .user-text {
    background: var(--sidebar);
    max-width: 100%;
    padding: 10px 14px;
    border-radius: 12px;
    font-size: 14px;
    line-height: 1.7;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .message-actions {
    display: flex;
    margin-top: 4px;
  }
  .user .message-actions {
    position: absolute;
    top: 100%;
    right: 0;
    margin-top: 0;
    justify-content: flex-end;
  }
  .message-actions :global(button) {
    opacity: 0;
    transition:
      opacity var(--motion-fast) var(--motion-ease),
      background var(--motion-fast) var(--motion-ease),
      color var(--motion-fast) var(--motion-ease);
  }
  article:hover .message-actions :global(button),
  article:focus-within .message-actions :global(button),
  .message-actions :global(button.copied) {
    opacity: 1;
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
    border-radius: 5px;
  }
  summary:focus-visible,
  .suggestions button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 3px;
  }
  .reasoning {
    margin-top: 8px;
    max-height: 18rem;
    overflow: auto;
    border-left: 2px solid var(--border);
    padding-left: 12px;
  }
  .reasoning :global(.message-text) {
    font-size: 13px;
    color: var(--muted);
  }
  .reasoning-actions {
    display: flex;
    justify-content: flex-end;
    margin-bottom: 4px;
  }
  .reasoning-block > summary {
    display: flex;
    align-items: center;
    gap: 6px;
    list-style: none;
    font-size: 12px;
  }
  .reasoning-block > summary::-webkit-details-marker {
    display: none;
  }
  .reasoning-block svg {
    width: 12px;
    height: 12px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    transition: transform var(--motion-fast) var(--motion-ease);
  }
  .reasoning-block[open] > summary svg {
    transform: rotate(90deg);
  }
  .conversation-start {
    margin: auto 0;
    padding: 0 0 clamp(24px, 8dvh, 72px);
    text-align: left;
  }
  .conversation-start h2 {
    font-family: "Noto Serif SC Variable", serif;
    font-size: 30px;
    font-weight: 450;
    line-height: 1.4;
    letter-spacing: -0.02em;
    margin: 0;
  }
  .suggestions {
    display: grid;
    gap: 2px;
    margin-top: 24px;
  }
  .suggestions button {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 10px 0;
    border: 0;
    border-radius: 4px;
    color: var(--muted);
    background: transparent;
    box-shadow: none;
    font: inherit;
    text-align: left;
    cursor: pointer;
    transition:
      color 150ms ease;
  }
  .suggestions button:hover {
    background: transparent;
    color: var(--fg);
  }
  .suggestions button > span {
    font-size: 13px;
    font-weight: 400;
    line-height: 1.6;
  }
  .suggestions svg {
    flex-shrink: 0;
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .suggestions .suggestion-arrow {
    margin-left: auto;
    opacity: 0.4;
    transition: opacity 150ms ease;
  }
  .suggestions button:hover .suggestion-arrow,
  .suggestions button:focus-visible .suggestion-arrow {
    opacity: 1;
  }
  .run-status {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--accent);
    font-size: 12px;
  }
  .run-indicator {
    width: 12px;
    height: 12px;
    box-sizing: border-box;
    border: 1.5px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }
  .run-indicator.waiting {
    animation: none;
    border-color: var(--accent);
    background: var(--selected);
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .latest {
    position: absolute;
    bottom: 0.75rem;
    left: 50%;
    transform: translateX(-50%);
    background: var(--bg);
    box-shadow: 0 3px 12px var(--shadow);
    white-space: nowrap;
    border-radius: 20px;
    padding: 7px 12px;
    font-size: 11px;
  }
  @media (prefers-reduced-motion: reduce) {
    .run-indicator {
      animation: none;
    }
    .suggestions button,
    .suggestion-arrow,
    .reasoning-block svg,
    .message-actions :global(button) {
      transition: none;
    }
  }
  @media (max-width: 700px) {
    .message-column {
      padding: 1rem var(--conversation-inset, 20px);
    }
    .user {
      margin-left: 5%;
    }
  }
  @media (max-height: 560px) {
    .conversation-start {
      padding-bottom: 0;
    }
    .suggestions {
      margin-top: 16px;
    }
    .suggestions button {
      padding-block: 8px;
    }
  }
  @media (hover: none) {
    .message-actions :global(button) {
      opacity: 0.7;
    }
  }
</style>
