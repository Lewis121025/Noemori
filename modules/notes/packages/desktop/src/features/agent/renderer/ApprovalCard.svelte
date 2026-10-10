<script lang="ts">
  import type { AgentApproval } from "../shared/api";
  let {
    pending,
    count,
    approving,
    onApprove,
  }: {
    pending: AgentApproval;
    count: number;
    approving: boolean;
    onApprove: (
      approval: AgentApproval,
      decision: "allow_once" | "allow_for_session" | "deny",
    ) => void;
  } = $props();
  const capabilityNames = {
    webmcp: "网页工具",
    developer_logs: "页面日志",
    cdp: "页面诊断",
  };
  const capabilityDescriptions = {
    webmcp: "可调用此页面提供的工具，可能提交信息或修改网站数据。",
    developer_logs: "可读取此页面的控制台日志与错误，日志可能包含页面数据。",
    cdp: "可读取此页面的结构、样式与性能诊断信息；仅开放只读诊断操作。",
  };
</script>

<section class="approval" aria-label="权限审批" aria-busy={approving}>
  <div class="approval-heading">
    <svg viewBox="0 0 20 20" aria-hidden="true"
      ><path d="m10 2 6 3v5c0 4-6 7-6 7s-6-3-6-7V5zM10 6v4m0 3h.01" /></svg
    >
    <h3>
      {pending.request.type === "browser"
        ? "允许访问这个网站？"
        : pending.request.type === "browser_capability"
          ? `允许使用${capabilityNames[pending.request.request.capability]}？`
          : pending.request.type === "ui_launch"
            ? "允许启动应用？"
            : pending.request.type === "ui"
              ? "允许在后台操作这个窗口？"
              : pending.request.type === "network"
                ? "允许这次网络访问？"
                : "任务需要额外权限"}
    </h3>
    {#if count > 1}<span class="approval-count">还有 {count - 1} 项</span>{/if}
  </div>
  <div class="approval-context">
    {#if pending.request.type === "browser"}<p>{pending.request.request.reason}</p>
      <code>{pending.request.request.origin}</code>
    {:else if pending.request.type === "browser_capability"}<p>
        {pending.request.request.title}
      </p>
      <code>{pending.request.request.origin}</code>
      <p>{pending.request.request.reason}</p>
      <p>{capabilityDescriptions[pending.request.request.capability]}</p>
      <p>仅用于当前会话的此页面，导航或接管后失效。</p>
    {:else if pending.request.type === "ui_launch"}<p>
        {pending.request.request.app_name}
      </p>
      <code>{pending.request.request.bundle_id}</code>
      <p>{pending.request.request.reason}</p>
      <p>仅批准本次后台启动，不授予窗口控制权。</p>
    {:else if pending.request.type === "ui"}<p>
        {pending.request.request.app_name} · {pending.request.request.window_title}
      </p>
      <p>{pending.request.request.reason}</p>
      <p>你操作键盘、鼠标或切换窗口时，助手会暂停。</p>
      <p>粘贴操作会临时使用系统剪贴板；若剪贴板未被你或其他应用更改，完成后恢复原内容。</p>
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
  </div>
  <div class="approval-actions">
    <button
      class="reader-button"
      type="button"
      disabled={approving}
      onclick={() => onApprove(pending, "deny")}>拒绝</button
    >
    {#if pending.request.type !== "ui_launch"}<button
        class="reader-button"
        class:primary={pending.request.type === "browser" ||
          pending.request.type === "ui" ||
          pending.request.type === "browser_capability"}
        type="button"
        disabled={approving}
        onclick={() => onApprove(pending, "allow_for_session")}
        >{approving ? "正在提交…" : "此会话允许"}</button
      >{/if}
    {#if pending.request.type === "terminal" || pending.request.type === "network" || pending.request.type === "ui_launch"}<button
        class="reader-button primary"
        type="button"
        disabled={approving}
        onclick={() => onApprove(pending, "allow_once")}>批准本次</button
      >{/if}
  </div>
</section>

<style>
  .approval {
    display: flex;
    flex-direction: column;
    /* 审批与队列共存时先收缩可滚动正文，确认按钮不能越过卡片边界。 */
    flex-shrink: 1;
    min-height: 0;
    box-sizing: border-box;
    align-self: center;
    width: calc(100% - 2 * var(--conversation-inset, 20px));
    max-width: var(--conversation-width, 44rem);
    max-height: min(300px, 36dvh);
    margin: 8px var(--conversation-inset, 20px) 0;
    border: 1px solid color-mix(in srgb, var(--accent) 15%, var(--border));
    border-radius: 16px;
    padding: 12px;
    background: var(--surface);
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  .approval-heading {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--accent);
    flex-shrink: 0;
  }
  .approval-heading svg {
    width: 15px;
    height: 15px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
    stroke-linecap: round;
    flex-shrink: 0;
  }
  .approval-count {
    margin-left: auto;
    color: var(--muted);
    font-size: 11px;
    white-space: nowrap;
  }
  h3 {
    margin: 0;
    font-size: 13px;
    font-weight: 500;
    line-height: 1.5;
    color: var(--fg);
  }
  .approval-context {
    flex: 1;
    min-height: 0;
    max-height: min(160px, 22dvh);
    margin-top: 8px;
    overflow: auto;
    overscroll-behavior: contain;
    color: var(--muted);
    line-height: 1.65;
  }
  p {
    margin: 4px 0;
  }
  code,
  pre {
    color: var(--fg);
    font-family: "JetBrains Mono Variable", monospace;
    font-size: 12px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  pre {
    margin: 8px 0;
    padding: 8px;
    border: 0;
    border-radius: var(--radius-control);
    background: var(--bg);
  }
  .approval-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 6px;
    margin-top: 12px;
    flex-shrink: 0;
  }
  .approval-actions button {
    min-height: 30px;
    padding: 5px 9px;
    font-size: 11px;
    box-shadow: none;
    border-radius: var(--radius-control);
    border-color: transparent;
    background: transparent;
  }
  .approval-actions button:hover:not(:disabled, .primary) {
    background: var(--control-hover, var(--selected));
  }
  .approval-actions button.primary {
    background: var(--accent-fill);
    color: var(--accent-text);
  }
</style>
