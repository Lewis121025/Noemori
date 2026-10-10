<script lang="ts">
  import { onDestroy, tick, untrack } from "svelte";
  import type { AgentApi, AgentTerminal } from "../shared/api";
  import CopyButton from "./CopyButton.svelte";
  let {
    api,
    session,
    terminal,
  }: {
    api: Pick<AgentApi, "terminalRead">;
    session: string;
    terminal: AgentTerminal;
  } = $props();
  let text = $state("");
  let issue = $state("");
  let clipped = $state(false);
  let loaded = $state(false);
  let viewport = $state<HTMLPreElement | undefined>();
  let cursor = 0;
  let disposed = false;
  let pumping = false;
  let again = false;
  const decoders = {
    stdout: new TextDecoder(),
    stderr: new TextDecoder(),
    terminal: new TextDecoder(),
  };
  const bytes = $derived(terminal.bytes);
  const status = $derived(terminal.process.status);

  function append(value: string): void {
    const characters = Array.from(text + value);
    if (characters.length > 30_000) clipped = true;
    text = characters.slice(-30_000).join("");
  }
  async function pump(): Promise<void> {
    if (disposed) return;
    if (pumping) {
      again = true;
      return;
    }
    pumping = true;
    const owner = session,
      process = terminal.process.session_id;
    issue = "";
    try {
      do {
        again = false;
        let more = true;
        while (more && !disposed) {
          const page = await api.terminalRead(owner, process, String(cursor));
          if (disposed || owner !== session || process !== terminal.process.session_id) return;
          const follow =
            !viewport || viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 24;
          if (page.has_more && page.next_offset <= cursor)
            throw new Error("命令输出游标未前进，请重新读取。");
          for (const chunk of page.chunks) {
            const raw = atob(chunk.data_base64);
            append(
              decoders[chunk.stream].decode(
                Uint8Array.from(raw, (character) => character.charCodeAt(0)),
                { stream: true },
              ),
            );
          }
          cursor = page.next_offset;
          more = page.has_more;
          if (!more && page.process.status !== "running")
            for (const decoder of Object.values(decoders)) append(decoder.decode());
          loaded = true;
          await tick();
          if (!disposed && follow && viewport) viewport.scrollTop = viewport.scrollHeight;
        }
      } while (again && !disposed);
    } catch (cause) {
      if (!disposed) issue = cause instanceof Error ? cause.message : String(cause);
    } finally {
      pumping = false;
    }
  }
  $effect(() => {
    void bytes;
    void status;
    untrack(() => void pump());
  });
  onDestroy(() => {
    disposed = true;
  });
</script>

<div class="live-output">
  <div class="output-heading">
    <span>输出</span>{#if text}<CopyButton {text} label="复制输出" iconOnly />{/if}
  </div>
  {#if text}<pre bind:this={viewport}>{text}</pre>
  {:else}<p class="empty-output" role="status">
      {loaded
        ? terminal.process.status === "running"
          ? "等待输出…"
          : "无文本输出"
        : "正在读取输出…"}
    </p>{/if}
  {#if clipped}<p class="output-note">显示最近 30,000 个字符，复制保留当前显示内容。</p>{/if}
  {#if issue}<div class="read-error" role="alert">
      <span>{issue}</span><button type="button" onclick={() => void pump()}>重新读取</button>
    </div>{/if}
</div>

<style>
  .live-output {
    padding: 6px 12px 12px;
    border-radius: 8px;
    background: var(--bg);
  }
  .output-heading {
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
    font-family: var(--tool-output-font, "JetBrains Mono Variable", monospace);
    font-size: var(--tool-output-size, 12px);
    line-height: 1.75;
    color: var(--fg);
    tab-size: 2;
  }
  .empty-output,
  .output-note {
    margin: 8px 0 0;
    font-size: 11px;
    color: var(--muted);
    line-height: 1.6;
  }
  .read-error {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 8px;
    color: var(--danger);
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  button {
    flex-shrink: 0;
    border: 0;
    border-radius: 4px;
    background: var(--selected);
    color: var(--fg);
    font: inherit;
    padding: 4px 6px;
    cursor: pointer;
  }
  button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
</style>
