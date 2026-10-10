<script lang="ts">
  import type {
    AgentApi,
    AgentUi,
    UiInstallation,
    UiPermissions,
    UiPreviewTarget,
  } from "../shared/api";
  import AgentPreview from "./AgentPreview.svelte";
  let {
    api,
    session,
    ui,
    settingsOpen = false,
  }: { api: AgentApi; session: string; ui: AgentUi; settingsOpen?: boolean } = $props();
  let changing = $state(false);
  let error = $state("");
  let preview = $state<{ target: UiPreviewTarget; title: string } | null>(null);
  let installation = $state<UiInstallation | null>(null);
  let permissions = $state<UiPermissions | null>(null);
  const labels = {
    idle: "未启动",
    ready: "可继续操作",
    busy: "正在操作",
    failed: "运行失败",
    closed: "已关闭",
  };
  const sources = {
    chrome: "Chrome · 你的浏览器",
    edge: "Edge · 你的浏览器",
    computer: "macOS 应用",
  };
  const outcomes = {
    observed: "已观察",
    executed: "已执行",
    not_executed: "未执行",
    unknown: "结果未确认",
  };
  const latest = $derived(ui.receipts.at(-1));
  let lastWindow: string | null = null;
  let lastHuman = false;
  $effect(() => {
    const control = ui.control;
    const human = ui.connections.some(
      (connection) => connection.backend === "computer" && connection.connected && connection.human,
    );
    const window = control ? JSON.stringify([control.app, control.window]) : null;
    if (control && (window !== lastWindow || (human && !lastHuman)))
      preview = {
        target: { backend: "computer", app: control.app, window: control.window },
        title: `${control.app_name} · ${control.window_title}`,
      };
    lastWindow = window;
    lastHuman = human;
  });

  async function perform(work: () => Promise<void>): Promise<void> {
    changing = true;
    error = "";
    try {
      await work();
    } catch (reason) {
      error = reason instanceof Error ? reason.message : String(reason);
    } finally {
      changing = false;
    }
  }
</script>

<section aria-label="浏览器与应用控制" class="ui-control">
  <details open={settingsOpen || ui.connections.length > 0 || ui.status === "busy"}>
    <summary>浏览器与应用 <span>{labels[ui.status]}</span></summary>
    {#each ui.connections as connection (connection.id)}
      <div class="connection">
        <header>
          <strong>{sources[connection.backend]}</strong>
          <span
            >{!connection.connected
              ? "连接已断开"
              : connection.human
                ? "由你操作"
                : connection.backend === "computer"
                  ? "已连接"
                  : "助手可操作"}</span
          >
          {#if connection.connected && ui.status !== "closed"}
            <button
              disabled={changing ||
                (connection.backend === "computer" && connection.human && !ui.control)}
              onclick={() =>
                void perform(() => api.uiControl(session, connection.backend, connection.human))}
            >
              {connection.human ? "完成并继续" : "接管"}
            </button>
          {/if}
        </header>
        {#if connection.backend === "computer" && ui.control}
          <p>{ui.control.app_name} · {ui.control.window_title}</p>
          <button
            onclick={() => {
              if (ui.control)
                preview = {
                  target: { backend: "computer", app: ui.control.app, window: ui.control.window },
                  title: `${ui.control.app_name} · ${ui.control.window_title}`,
                };
            }}>查看画面</button
          >
        {/if}
        {#each connection.tabs as tab (tab.id)}<p title={tab.url}>{tab.title || tab.url}</p>
          {#if connection.backend !== "computer" && !connection.human}
            <button
              onclick={() => {
                if (connection.backend !== "computer")
                  preview = {
                    target: { backend: connection.backend, page: tab.id },
                    title: tab.title || tab.url,
                  };
              }}>查看画面</button
            >
          {/if}
        {/each}
        {#if !connection.connected}<p>重新连接后，请在可信界面交还控制并重新观察。</p>{/if}
      </div>
    {/each}
    {#if latest}
      <p>
        {latest.backend} · {latest.action} · {latest.pending
          ? "等待结算"
          : outcomes[latest.outcome]}
      </p>
      {#if latest.outcome === "unknown"}<p>上一步可能已生效，请核验结果。</p>{/if}
      {#if latest.error}<p class="error">{latest.error}</p>{/if}
    {/if}
    <details open={settingsOpen}>
      <summary>连接浏览器与系统权限</summary>
      <button
        disabled={changing}
        onclick={() =>
          void perform(async () => {
            installation = await api.uiSetup();
          })}>设置 Chrome / Edge 连接</button
      >
      {#if installation}
        <p>在 Chrome 或 Edge 的扩展管理页开启开发者模式，选择“加载已解压的扩展”，加载以下目录：</p>
        <code>{installation.extensionDirectory}</code>
        <p>打开 Noemori 扩展，连接应用，选择当前任务并共享标签页。模型会明确选择浏览器。</p>
      {/if}
      <button
        disabled={changing || ui.status === "closed"}
        onclick={() =>
          void perform(async () => {
            permissions = await api.uiPermissions(session);
          })}>检查 macOS 权限</button
      >
      {#if permissions}
        <p>
          辅助功能：{permissions.accessibility
            ? "已授权"
            : "未授权"}；屏幕录制：{permissions.screen_recording ? "已授权" : "未授权"}
        </p>
        <p>
          请在系统设置的“隐私与安全性”中授权 Noemori Computer
          Helper。助手在后台操作；你切换到目标应用时会暂停。
        </p>
      {/if}
    </details>
    {#if ui.error || error}<p class="error" role="alert">{error || ui.error}</p>{/if}
  </details>
</section>

{#if preview}
  <AgentPreview
    {api}
    {session}
    target={preview.target}
    title={preview.title}
    human={ui.connections.some(
      (connection) => connection.backend === preview?.target.backend && connection.human,
    )}
    control={preview.target.backend === "computer"
      ? (resume) => api.uiControl(session, "computer", resume)
      : null}
    close={() => {
      preview = null;
    }}
  />
{/if}

<style>
  .ui-control {
    border: 1px solid #8884;
    border-radius: 8px;
    padding: 10px;
    font-size: 12px;
  }
  summary {
    cursor: pointer;
  }
  summary span {
    margin-left: 8px;
    opacity: 0.7;
  }
  header {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  header span {
    flex: 1;
    opacity: 0.7;
  }
  .connection {
    margin-top: 10px;
  }
  button {
    border: 1px solid #8885;
    border-radius: 5px;
    padding: 5px 8px;
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;
    margin-top: 6px;
  }
  button:disabled {
    opacity: 0.5;
    cursor: wait;
  }
  p {
    margin: 6px 0;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }
  code {
    user-select: text;
    overflow-wrap: anywhere;
  }
  details details {
    margin-top: 10px;
  }
  .error {
    color: #c0392b;
  }
</style>
