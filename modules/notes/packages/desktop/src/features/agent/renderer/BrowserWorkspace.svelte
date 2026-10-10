<script lang="ts">
  import { untrack } from "svelte";
  import type { AgentApi, AgentBrowser } from "../shared/api";

  let { api, session, browser }: { api: AgentApi; session: string; browser: AgentBrowser } =
    $props();
  let selected = $state<string | null>(null);
  let error = $state("");
  let busy = $state(false);
  let prompt = $state("");
  const current = $derived(
    browser.tabs.find((tab) => tab.id === selected) ??
      browser.tabs.find((tab) => tab.id === browser.handoff?.page) ??
      browser.tabs.at(-1),
  );
  const site = $derived.by(() => {
    try {
      return current ? new URL(current.url).hostname : "";
    } catch {
      return "";
    }
  });
  // 初次展示遵循协助目标；登录中新开的窗口接续显示，关闭后回到原页面。
  let previousPage: string | undefined;
  let initialized = false;
  $effect(() => {
    const latest = browser.tabs.at(-1)?.id;
    if (initialized && latest && latest !== previousPage) selected = latest;
    previousPage = latest;
    initialized = true;
  });
  async function perform(work: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = true;
    error = "";
    try {
      await work();
    } catch (reason) {
      error = reason instanceof Error ? reason.message : String(reason);
    } finally {
      busy = false;
    }
  }
  function portal(node: HTMLElement) {
    document.body.append(node);
    return { destroy: () => node.remove() };
  }
  function viewport(node: HTMLElement) {
    const owner = session;
    let ended = false;
    let queued = false;
    const update = () => {
      if (ended || queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (ended) return;
        const page = current;
        const bounds = node.getBoundingClientRect();
        if (!page?.native_target || bounds.width <= 0 || bounds.height <= 0) {
          void api.browserView(owner, null).catch((reason: unknown) => {
            if (!ended) error = String(reason);
          });
          return;
        }
        void api
          .browserView(owner, {
            page: page.id,
            human: true,
            bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
          })
          .catch((reason: unknown) => {
            if (!ended) error = String(reason);
          });
      });
    };
    const resize = new ResizeObserver(update);
    resize.observe(node);
    window.addEventListener("resize", update);
    const stop = $effect.root(() => {
      $effect(() => {
        void current;
        untrack(update);
      });
    });
    update();
    return {
      destroy() {
        ended = true;
        resize.disconnect();
        stop();
        window.removeEventListener("resize", update);
        void api
          .browserView(owner, null)
          .catch((reason: unknown) => console.error("浏览器视图隐藏失败", reason));
      },
    };
  }
  async function reply(accept: boolean): Promise<void> {
    if (!current) return;
    const page = current.id;
    const preview = await api.uiPreview(session, { backend: "managed", page });
    if (!preview.inputToken) throw new Error("网页对话框控制权已改变");
    await api.browserInput(session, page, preview.inputToken, {
      type: "dialog",
      accept,
      ...(current.dialog?.type === "prompt" ? { text: prompt } : {}),
    });
    prompt = "";
  }
</script>

<div use:portal class="browser-workspace" role="dialog" aria-label="浏览器协助" tabindex="-1">
  <header title={current?.url}>
    <span class="status-dot" aria-hidden="true"></span>
    <span>{site || current?.title || "浏览器"}</span>
  </header>
  {#if error || browser.error}<p class="error" role="alert">{error || browser.error}</p>{/if}
  {#if current?.dialog}
    <div class="web-dialog" role="alertdialog" aria-label="网页对话框">
      <p>{current.dialog.message}</p>
      {#if current.dialog.type === "prompt"}<input
          bind:value={prompt}
          aria-label="网页对话框输入"
        />{/if}
      <div class="dialog-actions">
        {#if current.dialog.type !== "alert"}<button
            disabled={busy}
            onclick={() => void perform(() => reply(false))}>取消</button
          >{/if}
        <button disabled={busy} onclick={() => void perform(() => reply(true))}>确定</button>
      </div>
    </div>
  {/if}
  <div class="browser-viewport" use:viewport>
    {#if current?.crashed}<p role="alert">页面已退出</p>{:else if !current?.native_target}<span
        class="loading"
        role="status"
        aria-label="正在连接页面"
      ></span>{/if}
  </div>
</div>

<style>
  .browser-workspace {
    position: fixed;
    z-index: 1090;
    top: 76px;
    right: 24px;
    width: min(680px, calc(100vw - 48px));
    height: min(480px, calc(100vh - 100px));
    min-width: min(360px, calc(100vw - 48px));
    min-height: min(240px, calc(100vh - 100px));
    max-width: calc(100vw - 48px);
    max-height: calc(100vh - 100px);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    resize: both;
    padding: 0 10px 10px;
    border: 1px solid light-dark(rgb(255 255 255 / 78%), rgb(255 255 255 / 16%));
    border-radius: 18px;
    background: light-dark(rgb(247 249 246 / 76%), rgb(36 40 37 / 78%));
    backdrop-filter: blur(28px) saturate(120%);
    color: light-dark(#4d5750, #d5dcd6);
    box-shadow:
      inset 0 1px 0 light-dark(#fff9, #fff1),
      0 18px 64px light-dark(#1b302b26, #0006);
  }
  header {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 7px;
    height: 36px;
    flex-shrink: 0;
    font-size: 11px;
    letter-spacing: 0.02em;
  }
  header > span:last-child {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .status-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: light-dark(#718b76, #9bb59d);
  }
  .browser-viewport {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow: hidden;
    border-radius: 8px;
    background: light-dark(#fff, #202420);
  }
  .browser-viewport p {
    padding: 24px;
    font-size: 12px;
  }
  .loading {
    position: absolute;
    top: calc(50% - 8px);
    left: calc(50% - 8px);
    width: 16px;
    height: 16px;
    border: 1.5px solid #8883;
    border-top-color: currentColor;
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }
  .error {
    margin: 0 6px 10px;
    font-size: 12px;
    color: light-dark(#ad4940, #ed9286);
  }
  .web-dialog {
    padding: 0 12px 16px;
    font-size: 13px;
  }
  .web-dialog p {
    overflow-wrap: anywhere;
  }
  .dialog-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  button,
  input {
    border: 1px solid #8884;
    border-radius: 6px;
    padding: 6px 10px;
    background: light-dark(#fff8, #fff1);
    color: inherit;
    font: inherit;
  }
  button {
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.5;
  }
  input {
    box-sizing: border-box;
    width: 100%;
    margin-bottom: 12px;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .loading {
      animation: none;
    }
  }
  @media (prefers-reduced-transparency: reduce), (prefers-contrast: more) {
    .browser-workspace {
      backdrop-filter: none;
      background: light-dark(#f7f9f6, #242825);
      border-color: currentColor;
    }
  }
</style>
