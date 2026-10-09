<script lang="ts">
  import type { AgentApi, AgentBrowser } from "../shared/api";
  import AgentPreview from "./AgentPreview.svelte";
  let { api, session, browser }: { api: AgentApi; session: string; browser: AgentBrowser } =
    $props();
  let changing = $state(false);
  let error = $state("");
  let preview = $state<string | null>(null);
  const previewTab = $derived(browser.tabs.find((tab) => tab.id === preview));
  const latest = $derived(browser.receipts.at(-1));
  const latestBatch = $derived(browser.receipts.findLast((receipt) => receipt.action === "batch"));
  const outcomes = {
    observed: "已观察",
    executed: "已执行",
    not_executed: "未执行",
    unknown: "结果未确认",
  };
  const actions: Record<string, string> = {
    fill: "填写",
    select: "选择",
    check: "设置勾选",
    click: "点击",
  };
  const labels: Record<AgentBrowser["status"], string> = {
    idle: "未启动",
    starting: "正在打开",
    ready: "可继续操作",
    busy: "正在操作",
    human: "由你操作",
    failed: "运行失败",
    closed: "已关闭",
  };
  async function control(resume: boolean): Promise<void> {
    changing = true;
    error = "";
    try {
      await api.browserControl(session, resume);
      if (!resume) preview = preview ?? browser.tabs[0]?.id ?? null;
    } catch (reason) {
      error = reason instanceof Error ? reason.message : String(reason);
    } finally {
      changing = false;
    }
  }
</script>

{#if browser.status !== "idle"}
  <section aria-label="会话浏览器" class="browser">
    <header>
      <strong>浏览器</strong><span>{labels[browser.status]}</span>
      {#if browser.status !== "failed" && browser.status !== "closed"}
        <button disabled={changing} onclick={() => void control(browser.status === "human")}>
          {changing ? "正在切换…" : browser.status === "human" ? "交还助手" : "接管浏览器"}
        </button>
      {/if}
    </header>
    {#if browser.status === "human"}<p>
        在画面浮窗中操作。完成后交还助手，再发送继续执行的要求。
      </p>{/if}
    <ul>
      {#each browser.tabs as tab (tab.id)}<li>
          <span title={tab.url}>{tab.title || tab.url}</span>
          <button onclick={() => { preview = tab.id; }}>查看画面</button>
          {#if tab.crashed}<em>页面已退出</em>{/if}
          {#if tab.file_chooser}<p>页面正在等待选择文件。</p>{/if}
          {#if tab.dialog}<p>{tab.dialog.message}</p>{/if}
        </li>{/each}
    </ul>
    {#if latest?.outcome === "unknown"}<p class="uncertain">
        上一步可能已生效，需要检查网页结果。
      </p>{/if}
    {#if latestBatch?.outcome === "unknown" && latestBatch.steps.length}
      <details open>
        <summary>最近批量操作的中断记录</summary>
        <ol>
          {#each latestBatch.steps as step (step.index)}<li>
              步骤 {step.index + 1}：{actions[step.action] || step.action} · {outcomes[
                step.outcome
              ]}
            </li>{/each}
        </ol>
      </details>
    {/if}
    {#if browser.error || error}<p class="error" role="alert">{error || browser.error}</p>{/if}
  </section>
{/if}

{#if previewTab}
  <AgentPreview {api} {session} target={{ backend: "managed", page: previewTab.id }} title={previewTab.title || "浏览器"} human={browser.status === "human"} dialog={previewTab.dialog} fileChooser={previewTab.file_chooser} close={() => { preview = null; }} />
{/if}

<style>
  .browser {
    border: 1px solid #8884;
    border-radius: 8px;
    padding: 10px;
    font-size: 12px;
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
  button {
    border: 1px solid #8885;
    border-radius: 5px;
    padding: 5px 8px;
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.5;
    cursor: wait;
  }
  ul {
    list-style: none;
    padding: 0;
    margin: 8px 0 0;
    max-height: 100px;
    overflow: auto;
  }
  li > span {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  p {
    margin: 6px 0 0;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }
  .uncertain {
    color: #ad731e;
  }
  details {
    margin-top: 8px;
  }
  summary {
    cursor: pointer;
  }
  ol {
    list-style: none;
    padding-left: 0;
    max-height: 120px;
    overflow: auto;
  }
  .error,
  em {
    color: #c0392b;
  }
</style>
