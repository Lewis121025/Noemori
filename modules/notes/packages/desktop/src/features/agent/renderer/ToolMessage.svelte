<script lang="ts">
  import CopyButton from "./CopyButton.svelte";
  import LiveToolOutput from "./LiveToolOutput.svelte";
  import type { AgentApi, AgentTerminal } from "../shared/api";
  import { toolAction, toolOutput, toolValueText, type ToolCall, type ToolResult } from "../shared/tool-presentation";
  let { call, result, running, api, session = "", terminal, targets }: {
    call: ToolCall | undefined;
    result: ToolResult | undefined;
    running: boolean;
    api?: AgentApi | undefined;
    session?: string;
    terminal?: AgentTerminal | undefined;
    targets?: ReadonlyMap<string, string> | undefined;
  } = $props();
  let expanded = $state(false);
  const view = $derived(result ? toolOutput(result) : null);
  const name = $derived(call?.name ?? result?.name ?? "");
  const action = $derived(toolAction(call, result, targets));
  const argumentsText = $derived(call ? toolValueText(call.arguments) : "");
  const resultText = $derived(result ? toolValueText(result.output) : "");
  const progress = $derived(terminal ? toolOutput({ call_id: call?.id ?? "", name: "terminal", output: { ...terminal.process, error: terminal.error ?? terminal.process.error }, is_error: false }) : view);
  const completed = $derived(progress?.tone === "normal" && progress.state === "已完成");
  const active = $derived(progress?.state === "后台运行" || (running && !progress));
  const attention = $derived(Boolean(progress?.tone === "error" || progress?.tone === "warning" || view?.error || view?.note));
  const error = $derived(progress?.error ?? view?.error);
  $effect(() => { if (attention) expanded = true; });
  // 仅命令日志与结构数据需要等宽排版，网页和应用返回的文本沿用正文阅读字体。
  const technical = $derived(name === "terminal" || (!view?.extracted && typeof result?.output !== "string"));
</script>

<details class:tool-call={Boolean(call)} class:tool-result={Boolean(result)} class:error={progress?.tone === "error"} class="tool-card" bind:open={expanded}>
  <summary>
    <svg class="activity-icon" class:active viewBox="0 0 20 20" aria-hidden="true">
      {#if completed}<path d="m5 10 3 3 7-7" />
      {:else if progress?.tone === "error" || progress?.tone === "warning"}<circle cx="10" cy="10" r="7" /><path d="M10 6v4m0 3v.1" />
      {:else}<circle cx="10" cy="10" r="6" />{/if}
    </svg>
    <span class="tool-description"><span class="tool-label">{action.label}</span>{#if action.target}<span class="tool-target" title={action.target}>{action.target}</span>{/if}</span>
    <span class="tool-state" class:quiet={completed} class:error={progress?.tone === "error"} class:warning={progress?.tone === "warning"}>{progress?.state ?? (running ? "等待结果" : "未返回结果")}</span>
    <svg class="disclosure" viewBox="0 0 20 20" aria-hidden="true"><path d="m7 5 5 5-5 5" /></svg>
  </summary>
  <div class="tool-body">
    {#if action.source}<div class="tool-source"><div class="raw-heading"><span>{action.sourceLabel}</span><CopyButton text={action.source} label={`复制${action.sourceLabel}`} iconOnly /></div><pre>{action.source}</pre></div>{/if}
    {#if error}<p class="tool-error">{error}</p>{/if}
    {#if expanded && api && terminal}{#key `${session}:${terminal.process.session_id}`}<LiveToolOutput {api} {session} {terminal} />{/key}{/if}
    {#if view}
      {#if view.text && !(api && terminal)}<div class="tool-output" class:technical>
          <div class="output-heading"><span>{view.label}</span><CopyButton text={view.text} label="复制输出" iconOnly /></div>
          <pre>{view.text}</pre>
        </div>
      {:else if !error && !(api && terminal)}<p class="empty-output">无文本输出</p>{/if}
      {#if view.note}<p class="output-note">{view.note}</p>{/if}
    {/if}
    {#if call || view?.extracted}<details class="tool-meta">
        <summary><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m7 5 5 5-5 5" /></svg>原始数据</summary>
        {#if call}<div class="raw-heading"><span>参数</span><CopyButton text={argumentsText} label="复制参数" iconOnly /></div><pre>{argumentsText}</pre>{/if}
        {#if view?.extracted}<div class="raw-heading"><span>原始结果</span><CopyButton text={resultText} label="复制原始结果" iconOnly /></div><pre>{resultText}</pre>{/if}
      </details>{/if}
  </div>
</details>

<style>
  .tool-card {
    margin: 4px 0;
    border: 0;
    border-radius: 10px;
    background: transparent;
    overflow: hidden;
    color: var(--muted);
    font-size: 12px;
  }
  .tool-card.error .activity-icon {
    color: var(--danger);
  }
  summary {
    cursor: pointer;
    list-style: none;
  }
  summary::-webkit-details-marker {
    display: none;
  }
  .tool-card > summary {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 9px;
    min-width: 0;
    transition: background var(--motion-fast) var(--motion-ease);
  }
  .tool-card > summary:hover {
    background: var(--control-hover, var(--selected));
  }
  summary:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -3px;
    border-radius: 10px;
  }
  svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
    flex-shrink: 0;
  }
  .disclosure {
    width: 10px;
    opacity: 0.5;
    transition: transform var(--motion-fast) var(--motion-ease);
  }
  .tool-card[open] > summary .disclosure {
    transform: rotate(90deg);
  }
  .tool-description {
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex: 1;
    min-width: 0;
    font-size: 12px;
  }
  .tool-label { flex-shrink: 0; }
  .tool-target { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg); }
  .tool-state {
    flex-shrink: 0;
    font-size: 11px;
    white-space: nowrap;
  }
  .quiet {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
  .tool-state.error,
  .tool-error {
    color: var(--danger);
  }
  .warning,
  .output-note {
    color: var(--warning);
  }
  .tool-body {
    margin: 4px 0 12px 15px;
    padding: 0 8px 0 16px;
    border-left: 1px solid var(--border);
    min-width: 0;
  }
  .output-heading,
  .raw-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    font-size: 11px;
  }
  pre {
    margin: 4px 0 0;
    max-height: 18rem;
    overflow: auto;
    overscroll-behavior: contain;
    scrollbar-width: thin;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-family: inherit;
    font-size: 13px;
    line-height: 1.7;
    color: var(--fg);
    tab-size: 2;
  }
  .technical pre,
  .tool-meta pre,
  .tool-source pre {
    font-family: "JetBrains Mono Variable", monospace;
    font-size: 12px;
  }
  p {
    margin: 4px 0 8px;
    line-height: 1.7;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .output-note,
  .empty-output {
    margin: 8px 0 0;
    font-size: 11px;
  }
  .tool-meta {
    margin-top: 12px;
    font-size: 11px;
  }
  .tool-meta > summary {
    display: flex;
    align-items: center;
    gap: 3px;
    padding: 4px 0;
  }
  .tool-meta svg {
    width: 10px;
    height: 10px;
    transition: transform var(--motion-fast) var(--motion-ease);
  }
  .tool-meta[open] > summary svg {
    transform: rotate(90deg);
  }
  .raw-heading {
    margin-top: 8px;
  }
  .tool-source { margin-bottom: 12px; }
  .tool-source pre { padding: 8px 10px; background: color-mix(in srgb, var(--fg) 3%, var(--bg)); border-radius: 6px; }
  .tool-meta pre {
    padding: 8px;
    background: var(--bg);
    border-radius: 8px;
    font-size: 11px;
  }
  .activity-icon.active {
    stroke-dasharray: 24 14;
    animation: spin 1.2s linear infinite;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  @media (prefers-reduced-motion: reduce) {
    .tool-card > summary,
    .disclosure,
    .tool-meta svg {
      transition: none;
    }
    .activity-icon.active {
      animation: none;
    }
  }
</style>
