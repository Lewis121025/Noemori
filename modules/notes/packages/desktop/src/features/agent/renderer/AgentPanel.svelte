<script lang="ts">
  import { onMount } from "svelte";
  import type { AgentApi, AgentApproval, AgentSnapshot, ApprovalReply } from "../shared/api";
  import ModelSettings from "./ModelSettings.svelte";
  import AgentTerminal from "./AgentTerminal.svelte";
  import AgentBrowser from "./AgentBrowser.svelte";
  let { api, close }: { api: AgentApi; close: () => void } = $props();
  let sessions = $state<AgentSnapshot[]>([]);
  let selected = $state<string | null>(null);
  let prompt = $state("");
  let error = $state("");
  let settings = $state(false);
  let creating = $state(false);
  let terminalId = $state<string | null>(null);
  const current = $derived(sessions.find((session) => session.id === selected) ?? null);
  const terminal = $derived(
    current?.terminals.find((entry) => entry.process.session_id === terminalId) ??
      current?.terminals.at(-1) ??
      null,
  );
  const pending = $derived(current?.approvals[0] ?? null);
  async function load(): Promise<void> {
    sessions = await api.list();
    if (!sessions.some((session) => session.id === selected))
      selected = sessions.at(-1)?.id ?? null;
  }
  async function refresh(id: string): Promise<void> {
    try {
      const snapshot = await api.snapshot(id);
      const index = sessions.findIndex((session) => session.id === id);
      if (index >= 0) sessions[index] = snapshot;
      else sessions.push(snapshot);
    } catch {
      await load();
    }
  }
  onMount(() => {
    void load().catch((reason: unknown) => {
      error = String(reason);
    });
    return api.subscribe((id) => {
      void refresh(id).catch((reason: unknown) => {
        error = String(reason);
      });
    });
  });
  async function create(): Promise<void> {
    creating = true;
    error = "";
    try {
      const session = await api.create();
      if (session) {
        sessions.push(session);
        selected = session.id;
        terminalId = null;
      }
    } catch (reason) {
      error = String(reason);
    } finally {
      creating = false;
    }
  }
  async function send(): Promise<void> {
    if (!current || prompt.trim() === "") return;
    const value = prompt;
    error = "";
    try {
      await api.start(current.id, value);
      prompt = "";
      await refresh(current.id);
    } catch (reason) {
      error = String(reason);
    }
  }
  async function decision(
    approval: AgentApproval,
    choice: "allow_once" | "allow_for_session" | "deny",
  ): Promise<void> {
    if (!current) return;
    error = "";
    const reply: ApprovalReply = {
      type: approval.request.type,
      decision:
        choice === "deny" ? { decision: choice, details: "用户拒绝" } : { decision: choice },
    };
    try {
      await api.approve(current.id, approval.id, reply);
    } catch (reason) {
      error = String(reason);
    }
  }
  async function remove(): Promise<void> {
    if (!current) return;
    try {
      await api.close(current.id);
      await load();
      terminalId = null;
    } catch (reason) {
      error = String(reason);
    }
  }
  async function openTerminal(): Promise<void> {
    if (!current) return;
    try {
      await api.terminalAction(current.id, {
        action: "exec",
        cmd: "/bin/sh -i",
        tty: true,
        yield_time_ms: 0,
      });
      await refresh(current.id);
    } catch (reason) {
      error = String(reason);
    }
  }
</script>

<aside class="agent-panel" aria-label="工作区助手">
  <header class="panel-header">
    <strong>工作区助手</strong>
    <div>
      <button onclick={() => (settings = !settings)}>模型接口</button><button onclick={close}
        >关闭</button
      >
    </div>
  </header>
  {#if settings}<ModelSettings
      {api}
      saved={() => {
        error = "";
      }}
      close={() => (settings = false)}
    />
  {:else}
    <nav>
      <select aria-label="Agent 会话" bind:value={selected}
        ><option value={null}>选择会话</option>{#each sessions as session (session.id)}<option
            value={session.id}
            >{session.workspace.split(/[\\/]/).at(-1)}{session.run?.status === "running"
              ? " · 运行中"
              : ""}</option
          >{/each}</select
      ><button onclick={() => void create()} disabled={creating}
        >{creating ? "选择中…" : "新会话"}</button
      >{#if current}<button onclick={() => void remove()}>结束会话</button>{/if}
    </nav>
    {#if current}
      <p class="workspace" title={current.workspace}>{current.workspace}</p>
      {#key current.id}<AgentBrowser {api} session={current.id} browser={current.browser} />{/key}
      <div class="messages" aria-live="polite">
        {#each current.messages as message, index (index)}
          {#if message.content.length > 0}<article class:user={message.role === "user"}>
              {#each message.content as part, partIndex (partIndex)}
                {#if part.type === "text"}<div class="message-text">{part.value}</div>
                {:else if part.type === "reasoning"}<details>
                    <summary>思考过程</summary>
                    <div class="message-text">{part.value}</div>
                  </details>
                {:else if part.type === "tool_call"}<details class="tool">
                    <summary
                      >{part.value.name === "terminal"
                        ? "终端操作"
                        : part.value.name === "browser"
                          ? "浏览器操作"
                          : part.value.name}</summary
                    >
                    <pre>{JSON.stringify(part.value.arguments, null, 2)}</pre>
                  </details>
                {:else if part.type === "tool_result"}<details
                    class="tool"
                    open={part.value.is_error}
                  >
                    <summary>{part.value.is_error ? "操作失败" : "操作结果"}</summary>
                    <pre>{JSON.stringify(part.value.output, null, 2)}</pre>
                  </details>{/if}
              {/each}
            </article>{/if}
        {/each}
        {#if current.run?.status === "running"}<p class="status">
            正在处理…
          </p>{:else if current.run}<p class="status">
            {current.run.status}{current.run.error ? ` · ${current.run.error}` : ""}
          </p>{/if}
      </div>
      {#if pending}<section class="approval" aria-label="权限审批">
          <strong
            >{pending.request.type === "browser"
              ? "浏览器访问申请"
              : pending.request.type === "network"
                ? "网络访问申请"
                : "执行权限申请"}</strong
          >
          {#if pending.request.type === "browser"}<p>{pending.request.request.reason}</p>
            <p>{pending.request.request.origin}</p>
          {:else if pending.request.type === "network"}<p>
              {pending.request.request.target.host}:{pending.request.request.target.port} · {pending
                .request.request.target.protocol}
            </p>
            <pre>{pending.request.request.command}</pre>
          {:else}<p>{pending.request.request.permissions.reason}</p>
            <pre>{pending.request.request.command}</pre>
            <p>目录：{pending.request.request.workdir}</p>
            {#if pending.request.request.tty || pending.request.request.stdin}<p>
                该进程允许后续交互输入。
              </p>{/if}{#each pending.request.request.permissions.readable_paths as path (path)}<p>
                读取：{path}
              </p>{/each}{#each pending.request.request.permissions.writable_paths as path (path)}<p
              >
                读写：{path}
              </p>{/each}{#if pending.request.request.permissions.network}<p>
                申请网络权限；目标规则仍生效。
              </p>{/if}{/if}
          <div>
            {#if pending.request.type !== "browser"}<button
                onclick={() => void decision(pending, "allow_once")}>批准本次</button
              >{/if}<button onclick={() => void decision(pending, "allow_for_session")}
              >此会话允许</button
            ><button onclick={() => void decision(pending, "deny")}>拒绝</button>
          </div>
        </section>{/if}
      <form
        class="composer"
        onsubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          bind:value={prompt}
          aria-label="Agent 用户任务"
          placeholder="描述工作区任务…"
          rows="3"
        ></textarea>
        <div>
          <button type="button" onclick={() => void openTerminal()}>新终端</button
          >{#if current.run?.status === "running"}<button
              type="button"
              onclick={() =>
                void api.cancel(current.id).catch((reason: unknown) => {
                  error = String(reason);
                })}>停止生成</button
            >{:else}<button type="submit" disabled={prompt.trim() === ""}>发送</button>{/if}
        </div>
      </form>
      {#if terminal}<div class="terminal-tabs">
          <select aria-label="终端记录" bind:value={terminalId}
            ><option value={null}>最近终端</option
            >{#each current.terminals as entry (entry.process.session_id)}<option
                value={entry.process.session_id}>{entry.call_id} · {entry.process.status}</option
              >{/each}</select
          >
        </div>
        {#key `${current.id}:${terminal.process.session_id}`}<AgentTerminal
            {api}
            session={current.id}
            {terminal}
          />{/key}{/if}
    {:else}<div class="empty">
        <h3>在选择的工作区中完成任务</h3>
        <p>配置模型接口后创建会话。文件与网络的额外访问会在这里请求审批。</p>
        <button onclick={() => (settings = true)}>配置模型接口</button>
      </div>{/if}
  {/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</aside>

<style>
  .agent-panel {
    --agent-surface: #fff;
    position: fixed;
    right: 0;
    top: 0;
    bottom: 0;
    width: min(560px, 95vw);
    z-index: 1000;
    background: var(--agent-surface);
    color: #272a30;
    box-shadow: -8px 0 36px #0002;
    display: flex;
    flex-direction: column;
    padding: 16px;
    gap: 10px;
    font-family: "Inter Variable", "Noto Sans SC Variable", sans-serif;
  }
  .panel-header,
  nav,
  .composer div,
  .approval div {
    display: flex;
    gap: 8px;
    align-items: center;
    justify-content: space-between;
  }
  .panel-header {
    padding-top: 10px;
  }
  button,
  select,
  textarea {
    font: inherit;
    color: inherit;
    border: 1px solid #8885;
    border-radius: 6px;
    background: transparent;
    padding: 6px 8px;
  }
  button {
    cursor: pointer;
    font-size: 12px;
  }
  select {
    min-width: 0;
    flex: 1;
    font-size: 12px;
  }
  .workspace {
    font-size: 11px;
    opacity: 0.6;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    margin: 0;
  }
  .messages {
    flex: 1;
    min-height: 100px;
    overflow: auto;
    padding: 4px;
  }
  article {
    margin: 0 0 16px;
  }
  .user {
    background: #8881;
    border-radius: 8px;
    padding: 10px;
  }
  .message-text {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-size: 13px;
    line-height: 1.65;
  }
  details {
    font-size: 12px;
    margin: 6px 0;
  }
  summary {
    cursor: pointer;
    opacity: 0.75;
  }
  pre {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-family: "JetBrains Mono Variable", monospace;
    font-size: 11px;
    max-height: 220px;
    overflow: auto;
  }
  .status,
  .error {
    font-size: 12px;
  }
  .error {
    color: #c0392b;
    margin: 0;
  }
  .approval {
    border: 1px solid #d59832;
    border-radius: 8px;
    padding: 10px;
    font-size: 12px;
    max-height: 300px;
    overflow: auto;
  }
  .approval p {
    margin: 6px 0;
    overflow-wrap: anywhere;
  }
  .composer {
    display: grid;
    gap: 6px;
  }
  .composer textarea {
    resize: vertical;
    width: 100%;
    box-sizing: border-box;
    font-size: 13px;
  }
  .empty {
    padding: 30px 8px;
    font-size: 13px;
    line-height: 1.6;
  }
  .terminal-tabs {
    display: flex;
  }
  @media (prefers-color-scheme: dark) {
    .agent-panel {
      --agent-surface: #222428;
      color: #e6e7e8;
    }
  }
</style>
