<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import type { AgentApi } from "../shared/api";
  import type { ModelSelection, ProviderCatalog, ProviderUpdate } from "../shared/providers";
  import ProviderEditor from "./ProviderEditor.svelte";
  let { api, saved, close }: { api: AgentApi; saved: () => void; close: () => void } = $props();
  let catalog = $state<ProviderCatalog>({ providers: [], active: null });
  /** 空目录、新建草稿和已保存连接是互斥页面，避免 nullable 身份与编辑标志组合出非法状态。 */
  type EditorPage = { type: "empty" } | { type: "new" } | { type: "provider"; id: string };
  let page = $state<EditorPage>({ type: "empty" });
  const selected = $derived(page.type === "provider" ? page.id : null);
  let editorKey = $state(0);
  let dirty = $state(false);
  let confirming = $state(false);
  let departure: ((accepted: boolean) => void) | null = null;
  let deleting = $state(false);
  let query = $state("");
  let loading = $state(true);
  let busy = $state(false);
  let error = $state("");
  let notice = $state("");
  const provider = $derived(catalog.providers.find((item) => item.id === selected) ?? null);
  const activeProvider = $derived(
    catalog.providers.find((item) => item.id === catalog.active?.providerId),
  );
  const visible = $derived(
    catalog.providers.filter((item) =>
      `${item.name} ${item.address.url}`.toLowerCase().includes(query.toLowerCase()),
    ),
  );

  onMount(() => {
    void api
      .providersGet()
      .then((value) => {
        catalog = value;
        const id = value.active?.providerId ?? value.providers[0]?.id;
        page = id === undefined ? { type: "empty" } : { type: "provider", id };
      })
      .catch((reason: unknown) => {
        error = String(reason);
      })
      .finally(() => {
        loading = false;
      });
  });
  onDestroy(() => finishDeparture(false));

  function checkDeparture(decide: (accepted: boolean) => void): void {
    if (busy || confirming) {
      decide(false);
      return;
    }
    if (!dirty) {
      decide(true);
      return;
    }
    departure = decide;
    confirming = true;
  }
  function finishDeparture(accepted: boolean): void {
    const decide = departure;
    departure = null;
    confirming = false;
    if (accepted) dirty = false;
    decide?.(accepted);
  }
  /**
   * 所有离开配置页的入口共用同一确认，进行中的保存或第二个离开请求被拒绝。
   * @returns 无草稿或用户明确放弃时返回 true；取消、保存中或组件释放时返回 false。
   */
  export function confirmLeave(): Promise<boolean> {
    return new Promise(checkDeparture);
  }
  function navigate(id: string | null): void {
    checkDeparture((accepted) => {
      if (!accepted) return;
      page = id === null ? { type: "new" } : { type: "provider", id };
      editorKey += 1;
      deleting = false;
      error = "";
      notice = "";
    });
  }
  async function save(input: ProviderUpdate): Promise<void> {
    busy = true;
    error = "";
    try {
      catalog = await api.providersSave(input);
      const savedProvider =
        input.id === null
          ? catalog.providers.at(-1)
          : catalog.providers.find((provider) => provider.id === input.id);
      if (!savedProvider) throw new Error("保存结果缺少供应商，请重新加载配置");
      page = { type: "provider", id: savedProvider.id };
      dirty = false;
      editorKey += 1;
      notice = "供应商已保存。所有会话下一轮使用当前默认模型。";
      if (catalog.active) saved();
    } finally {
      busy = false;
    }
  }
  async function selectModel(selection: ModelSelection): Promise<void> {
    busy = true;
    error = "";
    try {
      catalog = await api.modelSelect(selection);
      notice = "默认模型已切换，正在生成的会话在本轮结束后生效。";
      saved();
    } catch (reason) {
      error = String(reason);
    } finally {
      busy = false;
    }
  }
  async function remove(): Promise<void> {
    if (!provider) return;
    busy = true;
    error = "";
    try {
      catalog = await api.providersRemove(provider.id);
      const id = catalog.active?.providerId ?? catalog.providers[0]?.id;
      page = id === undefined ? { type: "empty" } : { type: "provider", id };
      dirty = false;
      deleting = false;
      editorKey += 1;
      notice = "供应商已删除。";
    } catch (reason) {
      error = String(reason);
    } finally {
      busy = false;
    }
  }
</script>

<section class="model-settings" aria-label="供应商配置管理">
  <header class="page-header">
    <div>
      <h3>供应商与模型</h3>
      <p>保存独立连接，为所有会话选择默认模型。</p>
    </div>
    <button
      type="button"
      disabled={busy || confirming}
      onclick={() =>
        checkDeparture((accepted) => {
          if (accepted) close();
        })}>返回会话</button
    >
  </header>
  <div class="default-model">
    <span>当前默认</span><strong
      >{activeProvider
        ? `${activeProvider.name} / ${catalog.active?.modelId}`
        : "尚未选择模型"}</strong
    >
    <p>所有会话下一轮使用最新配置，当前生成继续完成。</p>
  </div>
  {#if loading}<p role="status">正在加载供应商…</p>
  {:else}
    <div class="provider-layout">
      <aside aria-label="供应商列表">
        <button
          class="add"
          type="button"
          disabled={busy || confirming}
          onclick={() => navigate(null)}>＋ 添加供应商</button
        >
        <input aria-label="搜索供应商" bind:value={query} placeholder="搜索名称或地址" />
        {#each visible as item (item.id)}
          <button
            class="provider-card"
            class:current={selected === item.id}
            type="button"
            disabled={busy || confirming}
            onclick={() => {
              if (selected !== item.id) navigate(item.id);
            }}
          >
            <span
              ><strong>{item.name}</strong>{#if catalog.active?.providerId === item.id}<small
                  >默认</small
                >{/if}</span
            >
            <span class="host">{item.address.url}</span><span class="metadata"
              >{item.models.length} 个模型 · {item.authentication.configured
                ? "已配置认证"
                : "无认证"}</span
            >
          </button>
        {/each}
        {#if catalog.providers.length === 0}<p>
            添加供应商后，连接和模型会保存在这里。
          </p>{:else if visible.length === 0}<p>没有匹配的供应商。</p>{/if}
      </aside>
      <div class="provider-detail">
        {#if confirming}
          <div class="confirmation" role="alert">
            <p>当前修改尚未保存，是否放弃？</p>
            <button type="button" onclick={() => finishDeparture(true)}>放弃修改</button><button
              type="button"
              onclick={() => finishDeparture(false)}>继续编辑</button
            >
          </div>
        {/if}
        {#if page.type !== "empty"}
          {#if provider}
            {@const currentProvider = provider}
            <section class="model-selection" aria-label="默认模型选择">
              <header>
                <h4>{provider.name}</h4>
                <button
                  class="danger"
                  type="button"
                  disabled={busy || confirming}
                  onclick={() => (deleting = true)}>删除供应商</button
                >
              </header>
              <div class="model-options">
                {#each provider.models as model (model.id)}<button
                    type="button"
                    class:chosen={catalog.active?.providerId === provider.id &&
                      catalog.active.modelId === model.id}
                    disabled={busy || confirming}
                    onclick={() =>
                      void selectModel({ providerId: currentProvider.id, modelId: model.id })}
                    aria-label={`设为默认模型 ${model.id}`}
                    >{model.id}{#if catalog.active?.providerId === provider.id && catalog.active.modelId === model.id}<span
                        >当前默认</span
                      >{/if}</button
                  >{/each}
              </div>
              {#if deleting}<div class="confirmation" role="alert">
                  <p>
                    删除“{provider.name}”及其认证？{catalog.active?.providerId === provider.id
                      ? "删除后需要重新选择默认模型。"
                      : ""}
                  </p>
                  <button
                    class="danger"
                    type="button"
                    disabled={busy || confirming}
                    onclick={() => void remove()}>确认删除供应商</button
                  ><button
                    type="button"
                    disabled={busy || confirming}
                    onclick={() => (deleting = false)}>取消</button
                  >
                </div>{/if}
            </section>
          {/if}
          {#key editorKey}<ProviderEditor
              {provider}
              busy={busy || confirming}
              {save}
              changed={() => (dirty = true)}
            />{/key}
        {:else}<div class="empty">
            <h4>连接你的模型服务</h4>
            <p>从预设开始，填写 API Key 和模型，或添加自定义网关、本地服务。</p>
            <button type="button" onclick={() => navigate(null)}>添加供应商</button>
          </div>{/if}
      </div>
    </div>
  {/if}
  {#if notice}<p role="status">{notice}</p>{/if}
  {#if error}<p class="danger" role="alert">{error}</p>{/if}
</section>

<style>
  .model-settings {
    display: grid;
    gap: 18px;
    color: var(--fg);
  }
  .page-header,
  .model-selection header {
    display: flex;
    gap: 12px;
    justify-content: space-between;
    align-items: center;
  }
  h3,
  h4 {
    margin: 0;
    font-size: 15px;
  }
  h4 {
    font-size: 13px;
  }
  p {
    font-size: 12px;
    line-height: 1.6;
    color: var(--muted);
    margin: 0;
  }
  input,
  button {
    font: inherit;
    color: inherit;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 7px;
    padding: 8px 10px;
    min-width: 0;
  }
  button {
    font-size: 12px;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .default-model {
    padding: 14px;
    border: 1px solid var(--border);
    border-radius: 10px;
    display: grid;
    gap: 5px;
  }
  .default-model > span {
    font-size: 11px;
    color: var(--muted);
  }
  .default-model strong {
    font-size: 13px;
    overflow-wrap: anywhere;
  }
  .provider-layout {
    display: grid;
    grid-template-columns: minmax(160px, 0.7fr) minmax(0, 1.8fr);
    gap: 20px;
    align-items: start;
  }
  aside {
    display: grid;
    gap: 8px;
  }
  aside > input {
    width: 100%;
    box-sizing: border-box;
    font-size: 12px;
  }
  .provider-card {
    text-align: left;
    display: grid;
    gap: 7px;
    padding: 12px;
  }
  .provider-card.current,
  .model-options .chosen {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 8%, var(--bg));
  }
  .provider-card > span:first-child {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .host {
    font-size: 11px;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .metadata {
    font-size: 11px;
    color: var(--muted);
  }
  small {
    color: var(--accent);
    font-size: 10px;
  }
  .provider-detail {
    min-width: 0;
    display: grid;
    gap: 18px;
    padding-left: 20px;
    border-left: 1px solid var(--border);
  }
  .model-selection {
    display: grid;
    gap: 12px;
    padding-bottom: 16px;
    border-bottom: 1px solid var(--border);
  }
  .model-options {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .model-options button {
    overflow-wrap: anywhere;
    text-align: left;
  }
  .model-options span {
    margin-left: 8px;
    font-size: 10px;
    color: var(--accent);
  }
  .danger {
    color: var(--danger);
  }
  .confirmation {
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .confirmation p {
    width: 100%;
  }
  .empty {
    padding: 28px 12px;
    display: grid;
    gap: 14px;
    justify-items: start;
  }
  @media (max-width: 600px) {
    .provider-layout {
      grid-template-columns: 1fr;
    }
    .provider-detail {
      padding-left: 0;
      border-left: 0;
      border-top: 1px solid var(--border);
      padding-top: 16px;
    }
  }
</style>
