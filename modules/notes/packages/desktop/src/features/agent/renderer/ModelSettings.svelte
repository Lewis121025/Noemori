<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import type { AgentApi } from "../shared/api";
  import type { ProviderCatalog, ProviderUpdate } from "../shared/providers";
  import ProviderEditor from "./ProviderEditor.svelte";
  let { api, saved }: { api: AgentApi; saved: () => void } = $props();
  let catalog = $state<ProviderCatalog>({ providers: [] });
  /** 没有连接时直接编辑首个草稿；已保存连接与新草稿仍以独立身份切换。 */
  type EditorPage = { type: "new" } | { type: "provider"; id: string };
  let page = $state<EditorPage>({ type: "new" });
  const selected = $derived(page.type === "provider" ? page.id : null);
  let editorKey = $state(0);
  let dirty = $state(false);
  let confirming = $state(false);
  let departure: ((accepted: boolean) => void) | null = null;
  let deleting = $state(false);
  let loading = $state(true);
  let busy = $state(false);
  let error = $state("");
  let notice = $state("");
  const provider = $derived(catalog.providers.find((item) => item.id === selected) ?? null);

  onMount(() => {
    void api
      .providersGet()
      .then((value) => {
        catalog = value;
        const id = value.providers[0]?.id;
        page = id === undefined ? { type: "new" } : { type: "provider", id };
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
      notice = "供应商已保存。";
      if (savedProvider.models.length === 0) {
        notice = "连接已保存，正在获取模型…";
        try {
          catalog = await api.providersRefresh(savedProvider.id);
          editorKey += 1;
          notice = "连接已保存，模型可在对话中选择。";
        } catch (reason) {
          notice = "连接已保存，可在对话中重试获取模型。";
          error = `模型获取失败：${String(reason)}`;
        }
      }
      saved();
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
      const id = catalog.providers[0]?.id;
      page = id === undefined ? { type: "new" } : { type: "provider", id };
      dirty = false;
      deleting = false;
      editorKey += 1;
      notice = "供应商已删除。";
      saved();
    } catch (reason) {
      error = String(reason);
    } finally {
      busy = false;
    }
  }
</script>

<section class="model-settings" aria-label="供应商配置管理">
  {#if loading}<p role="status">正在加载供应商…</p>
  {:else}
    {#if catalog.providers.length > 0}
      <div class="connections">
        <label
          >连接<select
            aria-label="已保存供应商"
            value={selected ?? ""}
            disabled={busy || confirming}
            onchange={(event) => {
              const id = event.currentTarget.value;
              event.currentTarget.value = selected ?? "";
              if (id !== selected) navigate(id);
            }}
          >
            {#if page.type === "new"}<option value="" disabled>新连接</option>{/if}
            {#each catalog.providers as item (item.id)}<option value={item.id}>{item.name}</option
              >{/each}
          </select></label
        >
        {#if page.type === "provider"}<button
            class="add"
            type="button"
            aria-label="＋ 添加供应商"
            title="添加供应商"
            disabled={busy || confirming}
            onclick={() => navigate(null)}>＋</button
          >{/if}
      </div>
    {/if}
    {#if confirming}<div class="confirmation" role="alert">
        <p>当前修改尚未保存，是否放弃？</p>
        <button type="button" onclick={() => finishDeparture(true)}>放弃修改</button>
        <button type="button" onclick={() => finishDeparture(false)}>继续编辑</button>
      </div>{/if}
    {#if deleting && provider}<div class="confirmation" role="alert">
        <p>
          删除“{provider.name}”及其认证？使用此连接的对话需要重新选择模型。
        </p>
        <button
          class="danger"
          type="button"
          disabled={busy || confirming}
          onclick={() => void remove()}>确认删除供应商</button
        >
        <button type="button" disabled={busy || confirming} onclick={() => (deleting = false)}
          >取消</button
        >
      </div>{/if}
    {#key editorKey}<ProviderEditor
        {provider}
        busy={busy || confirming}
        {save}
        remove={() => (deleting = true)}
        discover={(connection) => api.providersDiscover(connection)}
        changed={() => {
          dirty = true;
          notice = "";
        }}
      />{/key}
  {/if}
  {#if notice}<p role="status">{notice}</p>{/if}
  {#if error}<p class="danger" role="alert">{error}</p>{/if}
</section>

<style>
  .model-settings {
    display: grid;
    gap: 16px;
    min-width: 0;
    color: var(--fg);
  }
  .connections {
    display: flex;
    gap: 8px;
    align-items: end;
  }
  label {
    display: grid;
    flex: 1;
    min-width: 0;
    gap: 5px;
    font-size: 12px;
  }
  p {
    font-size: 12px;
    line-height: 1.5;
    color: var(--muted);
    margin: 0;
  }
  select,
  button {
    font: inherit;
    color: inherit;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px 10px;
    min-width: 0;
  }
  button {
    cursor: pointer;
    font-size: 12px;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .add {
    font-size: 18px;
    padding: 4px 10px;
    height: 34px;
  }
  .danger {
    color: var(--danger);
  }
  .confirmation {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding: 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
  }
  .confirmation p {
    width: 100%;
  }
</style>
