<script lang="ts">
  import CopyButton from "./CopyButton.svelte";
  import LiveToolOutput from "./LiveToolOutput.svelte";
  import MediaContent from "./MediaContent.svelte";
  import ContentCard from "./ContentCard.svelte";
  import { contentKind, fileContentReference } from "../shared/content";
  import type { AgentApi, AgentTerminal } from "../shared/api";
  import {
    toolAction,
    toolOutput,
    toolValueText,
    type ToolCall,
    type ToolResult,
  } from "../shared/tool-presentation";
  let {
    call,
    result,
    running,
    api,
    session = "",
    terminal,
    targets,
    onInspect,
  }: {
    call: ToolCall | undefined;
    result: ToolResult | undefined;
    running: boolean;
    api?: AgentApi | undefined;
    session?: string;
    terminal?: AgentTerminal | undefined;
    targets?: ReadonlyMap<string, string> | undefined;
    onInspect?: (() => void) | undefined;
  } = $props();
  let expanded = $state(false);
  const view = $derived(result ? toolOutput(result) : null);
  const action = $derived(toolAction(call, result, targets));
  const argumentsText = $derived(call ? toolValueText(call.arguments) : "");
  const resultText = $derived(result ? toolValueText(result.output) : "");
  const progress = $derived(
    terminal
      ? toolOutput({
          call_id: call?.id ?? "",
          name: "terminal",
          output: { ...terminal.process, error: terminal.error ?? terminal.process.error },
          is_error: false,
        })
      : view,
  );
  const completed = $derived(progress?.tone === "normal" && progress.state === "已完成");
  const fileReference = $derived(
    action.fileReference
      ? fileContentReference(action.fileReference, navigator.userAgent.includes("Windows"))
      : null,
  );
  const filePreview = $derived(
    completed &&
      fileReference &&
      ["image", "pdf", "html", "audio", "video"].includes(contentKind(fileReference) ?? "")
      ? fileReference
      : null,
  );
  const active = $derived(progress?.state === "后台运行" || (running && !progress));
  const attention = $derived(
    Boolean(
      progress?.tone === "error" || progress?.tone === "warning" || view?.error || view?.note,
    ),
  );
  const error = $derived(progress?.error ?? view?.error);
  $effect(() => {
    if (attention) expanded = true;
  });
  // 阅读文件沿用正文字体；命令、搜索定位与结构数据保留等宽排版。
  const technical = $derived(
    ["command", "script", "search", "folder"].includes(action.kind) ||
      Boolean(view && !view.extracted && typeof result?.output !== "string"),
  );
</script>

<details
  class:tool-call={Boolean(call)}
  class:tool-result={Boolean(result)}
  class:error={progress?.tone === "error"}
  class:warning={progress?.tone === "warning"}
  class="tool-card"
  bind:open={expanded}
  style:--tool-output-font={technical
    ? '"JetBrains Mono Variable", monospace'
    : "var(--font-interface)"}
  style:--tool-output-size={technical ? "12px" : "13px"}
>
  <summary
    onclick={() => {
      if (!expanded) onInspect?.();
    }}
  >
    <span class="tool-icon"
      ><svg viewBox="0 0 20 20" aria-hidden="true">
        {#if action.kind === "file"}<path
            d="M11 2.5H5a1.5 1.5 0 0 0-1.5 1.5v12A1.5 1.5 0 0 0 5 17.5h10a1.5 1.5 0 0 0 1.5-1.5V8L11 2.5Z"
          /><path d="M11 2.5V8h5.5M7 11h6m-6 3h4" />
        {:else if action.kind === "search"}<circle cx="8.5" cy="8.5" r="5.5" /><path
            d="m12.5 12.5 4 4"
          />
        {:else if action.kind === "folder"}<path
            d="M2.5 5a1.5 1.5 0 0 1 1.5-1.5h4l2 2h6A1.5 1.5 0 0 1 17.5 7v8a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 15Z"
          />
        {:else if action.kind === "command"}<rect
            x="2.5"
            y="2.5"
            width="15"
            height="15"
            rx="4"
          /><path d="m8 6 5 4-5 4Z" />
        {:else if action.kind === "browser"}<circle cx="10" cy="10" r="7.5" /><path
            d="M2.5 10h15M10 2.5a14 14 0 0 0 0 15 14 14 0 0 0 0-15Z"
          />
        {:else if action.kind === "app"}<rect x="2.5" y="3.5" width="15" height="13" rx="2" /><path
            d="M2.5 7.5h15M5.5 5.5h.1m2.4 0h.1"
          />
        {:else if action.kind === "script"}<path d="m6 5-4 5 4 5m8-10 4 5-4 5M11.5 3l-3 14" />
        {:else}<path d="m10 2 2.5 5.5L18 10l-5.5 2.5L10 18l-2.5-5.5L2 10l5.5-2.5Z" />{/if}
      </svg></span
    >
    <span
      class="tool-description"
      class:untargeted={!action.target}
      class:source-kind={action.kind === "command" || action.kind === "script"}
      >{#if action.target}<span class="tool-target" title={action.target}>{action.target}</span
        >{/if}<span class="tool-label">{action.label}</span></span
    >
    <span
      class="tool-state"
      class:error={progress?.tone === "error"}
      class:warning={progress?.tone === "warning"}
    >
      <svg class="activity-icon" class:active viewBox="0 0 20 20" aria-hidden="true">
        {#if completed}<path d="m5 10 3 3 7-7" />
        {:else if progress?.tone === "error" || progress?.tone === "warning"}<circle
            cx="10"
            cy="10"
            r="7"
          /><path d="M10 6v4m0 3v.1" />
        {:else}<circle cx="10" cy="10" r="6" />{/if}
      </svg><span class:quiet={completed}
        >{progress?.state ?? (running ? "等待结果" : "未返回结果")}</span
      >
    </span>
    <svg class="disclosure" viewBox="0 0 20 20" aria-hidden="true"><path d="m7 5 5 5-5 5" /></svg>
  </summary>
  <div class="tool-body">
    {#if action.source}<div class="tool-source">
        <div class="raw-heading">
          <span>{action.sourceLabel}</span><CopyButton
            text={action.source}
            label={`复制${action.sourceLabel}`}
            iconOnly
          />
        </div>
        <pre>{action.source}</pre>
      </div>{/if}
    {#if error}<p class="tool-error">{error}</p>{/if}
    {#if expanded && api && filePreview}<ContentCard
        source={{ type: "reference", reference: filePreview }}
        {api}
        {session}
        {onInspect}
      />
    {:else if expanded && api && terminal}{#key `${session}:${terminal.process.session_id}`}<LiveToolOutput
          {api}
          {session}
          {terminal}
        />{/key}{/if}
    {#if view}
      {#if view.text && !(api && (terminal || filePreview))}<div class="tool-output">
          <div class="output-heading">
            <span>{view.label}</span><CopyButton text={view.text} label="复制输出" iconOnly />
          </div>
          <pre>{view.text}</pre>
        </div>
      {:else if !error && !(api && (terminal || filePreview))}<p class="empty-output">
          无文本输出
        </p>{/if}
      {#if view.note}<p class="output-note">{view.note}</p>{/if}
    {/if}
    {#if expanded}{#each result?.media ?? [] as media, index (index)}<MediaContent
          {media}
          {api}
          {session}
          {onInspect}
        />{/each}{/if}
    {#if call || view?.extracted}<details class="tool-meta">
        <summary
          ><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m7 5 5 5-5 5" /></svg
          >原始数据</summary
        >
        {#if call}<div class="raw-heading">
            <span>参数</span><CopyButton text={argumentsText} label="复制参数" iconOnly />
          </div>
          <pre>{argumentsText}</pre>{/if}
        {#if view?.extracted}<div class="raw-heading">
            <span>原始结果</span><CopyButton text={resultText} label="复制原始结果" iconOnly />
          </div>
          <pre>{resultText}</pre>{/if}
      </details>{/if}
  </div>
</details>

<style>
  .tool-card {
    margin: 6px 0;
    border: 1px solid transparent;
    border-radius: 12px;
    background: color-mix(in srgb, var(--sidebar) 52%, var(--bg));
    overflow: hidden;
    color: var(--muted);
    font-size: 12px;
    transition:
      background var(--motion-fast) var(--motion-ease),
      border-color var(--motion-fast) var(--motion-ease);
  }
  .tool-card[open] {
    border-color: color-mix(in srgb, var(--border) 80%, transparent);
    background: var(--surface);
  }
  .tool-card.error {
    border-color: color-mix(in srgb, var(--danger) 28%, var(--border));
  }
  .tool-card.warning {
    border-color: color-mix(in srgb, var(--warning) 28%, var(--border));
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
    gap: 10px;
    padding: 7px 10px;
    min-height: 44px;
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
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
    flex-shrink: 0;
  }
  .tool-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: 8px;
    background: var(--surface);
    color: var(--muted);
    flex-shrink: 0;
  }
  .tool-description {
    display: grid;
    gap: 1px;
    flex: 1;
    min-width: 0;
    line-height: 1.35;
  }
  .tool-target {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--fg);
    font-size: 13px;
    font-weight: 500;
  }
  .tool-label {
    font-size: 11px;
  }
  .untargeted .tool-label {
    color: var(--fg);
    font-size: 13px;
    font-weight: 500;
  }
  .source-kind .tool-label {
    grid-row: 1;
    color: var(--fg);
    font-size: 13px;
    font-weight: 500;
  }
  .source-kind .tool-target {
    grid-row: 2;
    color: var(--muted);
    font-size: 11px;
    font-weight: 400;
  }
  .tool-state {
    display: flex;
    align-items: center;
    gap: 5px;
    max-width: 44%;
    flex-shrink: 0;
    font-size: 11px;
    line-height: 1.4;
  }
  .activity-icon {
    width: 13px;
    height: 13px;
  }
  .disclosure {
    width: 11px;
    height: 11px;
    opacity: 0.65;
    transition: transform var(--motion-fast) var(--motion-ease);
  }
  .tool-card[open] > summary .disclosure {
    transform: rotate(90deg);
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
  .tool-state.warning,
  .output-note {
    color: var(--warning);
  }
  .tool-body {
    padding: 10px 12px 12px;
    border-top: 1px solid var(--border);
    min-width: 0;
  }
  .output-heading,
  .raw-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    font-size: 11px;
    color: var(--muted);
  }
  pre {
    margin: 6px 0 0;
    max-height: 16rem;
    overflow: auto;
    overscroll-behavior: contain;
    scrollbar-width: thin;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-family: var(--tool-output-font);
    font-size: var(--tool-output-size);
    line-height: 1.75;
    color: var(--fg);
    tab-size: 2;
  }
  .tool-output {
    padding: 6px 12px 12px;
    border-radius: 8px;
    background: var(--bg);
  }
  .tool-source {
    margin-bottom: 12px;
  }
  .tool-source pre,
  .tool-meta pre {
    font-family: "JetBrains Mono Variable", monospace;
    font-size: 11px;
  }
  .tool-source pre {
    margin-top: 2px;
    color: var(--muted);
    max-height: 8rem;
  }
  p {
    margin: 4px 0 8px;
    line-height: 1.7;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .tool-error {
    padding: 10px 12px;
    border-radius: 8px;
    background: color-mix(in srgb, var(--danger) 6%, var(--bg));
  }
  .output-note,
  .empty-output {
    margin: 8px 0 0;
    font-size: 11px;
  }
  .tool-meta {
    margin-top: 10px;
    font-size: 11px;
  }
  .tool-meta > summary {
    display: flex;
    align-items: center;
    gap: 4px;
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
  .tool-source .raw-heading {
    margin-top: 0;
  }
  .tool-meta pre {
    padding: 8px 10px;
    background: var(--bg);
    border-radius: 8px;
  }
  .activity-icon.active {
    stroke-dasharray: 24 14;
    animation: spin 1.2s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .tool-card,
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
