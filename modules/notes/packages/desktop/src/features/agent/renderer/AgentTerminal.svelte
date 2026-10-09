<script lang="ts">
  import { onMount } from "svelte";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import "@xterm/xterm/css/xterm.css";
  import type { AgentApi, AgentTerminal } from "../shared/api";
  let { api, session, terminal }: { api: AgentApi; session: string; terminal: AgentTerminal } =
    $props();
  let container: HTMLDivElement;
  let emulator = $state<Terminal | null>(null);
  let error = $state("");
  let offset = 0;
  let disposed = false;
  let pumping = false;
  let again = false;
  let writing = Promise.resolve();
  function input(data: Uint8Array): void {
    writing = writing
      .then(async () => {
        for (let start = 0; start < data.length; start += 16384)
          await api.terminalInput(
            session,
            terminal.process.session_id,
            data.slice(start, start + 16384),
          );
      })
      .catch((reason: unknown) => {
        error = String(reason);
      });
  }
  async function pump(): Promise<void> {
    if (!emulator || disposed) return;
    if (pumping) {
      again = true;
      return;
    }
    pumping = true;
    try {
      do {
        again = false;
        let more = true;
        while (more && !disposed) {
          const page = await api.terminalRead(session, terminal.process.session_id, String(offset));
          for (const chunk of page.chunks) {
            const raw = atob(chunk.data_base64);
            const bytes = Uint8Array.from(raw, (character) => character.charCodeAt(0));
            if (emulator && !disposed)
              await new Promise<void>((done) => emulator?.write(bytes, done));
          }
          offset = page.next_offset;
          more = page.has_more;
        }
      } while (again && !disposed);
    } catch (reason) {
      if (!disposed) error = String(reason);
    } finally {
      pumping = false;
    }
  }
  $effect(() => {
    void terminal.bytes;
    void terminal.process.status;
    void emulator;
    void pump();
  });
  $effect(() => {
    if (emulator) emulator.options.disableStdin = !terminal.tty || terminal.process.status !== "running";
  });
  onMount(() => {
    const current = new Terminal({
      fontFamily: '"JetBrains Mono Variable", monospace',
      fontSize: 12,
      convertEol: true,
      scrollback: 5000,
      theme: { background: "#17191c", foreground: "#eceef0" },
    });
    const fit = new FitAddon();
    current.loadAddon(fit);
    current.open(container);
    const scheme = matchMedia("(prefers-color-scheme: dark)");
    function updateTheme(): void {
      const colors = getComputedStyle(container);
      current.options.theme = { background: colors.backgroundColor, foreground: colors.color };
    }
    updateTheme();
    scheme.addEventListener("change", updateTheme);
    emulator = current;
    const typed = current.onData((value) => input(new TextEncoder().encode(value)));
    const binary = current.onBinary((value) =>
      input(Uint8Array.from(value, (character) => character.charCodeAt(0))),
    );
    let scheduled = 0;
    const resize = new ResizeObserver(() => {
      cancelAnimationFrame(scheduled);
      scheduled = requestAnimationFrame(() => {
        if (disposed) return;
        fit.fit();
        if (terminal.tty && terminal.process.status === "running")
          void api
            .terminalAction(session, {
              action: "resize",
              session_id: terminal.process.session_id,
              size: { rows: current.rows, columns: current.cols },
            })
            .catch((reason: unknown) => {
              error = String(reason);
            });
      });
    });
    resize.observe(container);
    fit.fit();
    return () => {
      disposed = true;
      resize.disconnect();
      cancelAnimationFrame(scheduled);
      typed.dispose();
      binary.dispose();
      scheme.removeEventListener("change", updateTheme);
      current.dispose();
      emulator = null;
    };
  });
</script>

<section class="agent-terminal">
  <header>
    <span>{terminal.process.status === "running" ? (terminal.tty ? "交互终端" : "命令输出") : "已结束"}</span>
    <div>
      <button
        onclick={() =>
          void api
            .terminalAction(session, {
              action: "interrupt",
              session_id: terminal.process.session_id,
            })
            .catch((reason: unknown) => {
              error = String(reason);
            })}
        disabled={terminal.process.status !== "running"}>中断</button
      ><button
        onclick={() =>
          void api.terminalStop(session, terminal.process.session_id).catch((reason: unknown) => {
            error = String(reason);
          })}
        disabled={terminal.process.status !== "running"}>停止</button
      >
    </div>
  </header>
  <div class="terminal-screen" bind:this={container}></div>
  {#if error || terminal.error}<p class="error" role="alert">{error || terminal.error}</p>{/if}
</section>

<style>
  .agent-terminal {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 5px 10px;
    font-size: 11px;
    color: var(--muted);
    flex-shrink: 0;
  }
  header div {
    display: flex;
    gap: 7px;
  }
  button {
    font: inherit;
    color: inherit;
    border: 0;
    background: transparent;
    cursor: pointer;
    padding: 3px 5px;
    border-radius: var(--radius-control);
  }
  button:hover:not(:disabled) {
    background: var(--control-hover, var(--selected));
    color: var(--fg);
  }
  button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .terminal-screen {
    flex: 1;
    min-height: 0;
    --terminal-bg: var(--bg);
    --terminal-fg: var(--fg);
    background: var(--terminal-bg);
    color: var(--terminal-fg);
    padding: 8px;
  }
  .error {
    color: var(--danger);
    font-size: 12px;
    margin: 4px 10px;
  }
</style>
