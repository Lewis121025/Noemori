<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import type { AgentApi } from "../shared/api";
  import type { ModelSelection, ProviderCatalog } from "../shared/providers";
  import { modelReasoningEfforts } from "../shared/reasoning";
  import ReasoningPicker from "./ReasoningPicker.svelte";
  let {
    api,
    conversationId,
    selection,
    running,
    available = $bindable(false),
    changed,
    configure,
    catalogVersion = 0,
  }: {
    api: AgentApi;
    conversationId: string;
    selection: ModelSelection | null;
    running: boolean;
    available?: boolean;
    changed: (selection: ModelSelection) => void;
    configure: () => void;
    catalogVersion?: number;
  } = $props();
  let catalog = $state<ProviderCatalog>({ providers: [] });
  let opened = $state(false);
  let reasoningOpened = $state(false);
  let loading = $state(true);
  // 待保存值只驱动编辑控件；对话选择始终以主进程回执为准，失败后自动回显原值。
  let pendingSelection = $state<ModelSelection | null>(null);
  let catalogError = $state("");
  let selectionError = $state("");
  const saving = $derived(pendingSelection !== null);
  const displayedEffort = $derived((pendingSelection ?? selection)?.reasoningEffort);
  const error = $derived([catalogError, selectionError].filter(Boolean).join("；"));
  let query = $state("");
  let element: HTMLDivElement;
  let trigger: HTMLButtonElement;
  let search: HTMLInputElement | undefined = $state();
  let menu: HTMLDivElement | undefined = $state();
  const instanceId = $props.id();
  const anchorName = `--conversation-model-${instanceId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  let version = 0;
  let live = true;
  const provider = $derived(catalog.providers.find((item) => item.id === selection?.providerId));
  const model = $derived(provider?.models.find((item) => item.id === selection?.modelId));
  const efforts = $derived(modelReasoningEfforts(model?.reasoning));
  const valid = $derived(Boolean(model));
  const searchQuery = $derived(query.trim().toLocaleLowerCase());
  const groups = $derived(
    catalog.providers.flatMap((item) => {
      const models = item.models.filter((entry) =>
        `${item.name} ${entry.id}`.toLocaleLowerCase().includes(searchQuery),
      );
      return models.length ? [{ provider: item, models }] : [];
    }),
  );
  $effect(() => {
    available = valid && !saving;
  });
  $effect(() => {
    void catalogVersion;
    void load(false);
  });
  onDestroy(() => {
    live = false;
    version += 1;
  });

  function close(focus = false): void {
    opened = false;
    if (focus) trigger.focus();
  }
  function toggle(): void {
    if (opened) {
      close();
      return;
    }
    query = "";
    reasoningOpened = false;
    opened = true;
    void load(false);
    void tick().then(() => {
      if (!live || !opened) return;
      search?.focus();
      menu?.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: "nearest" });
    });
  }
  /** 原生顶层浮层避免被 Agent 侧栏的滚动、裁剪和玻璃材质遮住。 */
  function showMenu(node: HTMLDivElement): void {
    node.showPopover();
  }
  function navigate(event: KeyboardEvent): void {
    if (!menu || event.isComposing || !["ArrowDown", "ArrowUp"].includes(event.key)) return;
    const options = Array.from(menu.querySelectorAll<HTMLButtonElement>(".model-option"));
    if (!options.length || saving) return;
    event.preventDefault();
    const index = options.findIndex((option) => option === document.activeElement);
    const next =
      index < 0
        ? event.key === "ArrowDown"
          ? 0
          : options.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
    options[next]?.focus();
  }

  async function load(refresh: boolean): Promise<void> {
    const request = ++version;
    loading = true;
    catalogError = "";
    try {
      let value = await api.providersGet();
      // 对话切换或新请求已接管后，旧读取不能再启动会写回模型目录的远端发现。
      if (!live || request !== version) return;
      const pending = value.providers.filter((item) => refresh || item.models.length === 0);
      const results = await Promise.allSettled(
        pending.map((item) => api.providersRefresh(item.id)),
      );
      if (!live || request !== version) return;
      const failures = results.flatMap((result, index) =>
        result.status === "rejected" ? [`${pending[index]!.name}：${String(result.reason)}`] : [],
      );
      if (pending.length) value = await api.providersGet();
      if (!live || request !== version) return;
      catalog = value;
      catalogError = failures.join("；");
    } catch (cause) {
      if (live && request === version) catalogError = String(cause);
    } finally {
      if (live && request === version) loading = false;
    }
  }
  async function choose(value: ModelSelection, dismiss = true): Promise<boolean> {
    if (saving) return false;
    pendingSelection = value;
    selectionError = "";
    const id = conversationId;
    const sourceMenu = menu;
    try {
      const receipt = await api.modelSelect(id, value);
      if (!live || conversationId !== id) return false;
      changed(receipt);
      // 保存只结束发起它的那次选择；用户已经离开或重开浮层时不再改变焦点。
      if (dismiss && opened && menu === sourceMenu) close(true);
      return true;
    } catch (cause) {
      if (live && conversationId === id) selectionError = String(cause);
      return false;
    } finally {
      if (live && conversationId === id) pendingSelection = null;
    }
  }
</script>

<svelte:window
  onpointerdown={(event) => {
    if (opened && event.target instanceof Node && !element.contains(event.target)) close();
  }}
  onkeydown={(event) => {
    if (opened && event.key === "Escape" && !event.isComposing) close(true);
  }}
/>
<div
  class="conversation-model"
  bind:this={element}
  onfocusout={(event) => {
    if (opened && event.relatedTarget instanceof Node && !element.contains(event.relatedTarget))
      close();
  }}
>
  <button
    class="model-trigger"
    type="button"
    aria-label="选择对话模型"
    aria-expanded={opened}
    aria-controls={`${instanceId}-models`}
    bind:this={trigger}
    style:anchor-name={anchorName}
    title={running ? "切换从下一轮生效" : "选择此对话的模型"}
    onclick={toggle}
  >
    <span>{selection?.modelId ?? "选择模型"}</span>
    <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 8 4 4 4-4" /></svg>
  </button>
  {#if model}<ReasoningPicker
      {efforts}
      value={displayedEffort}
      {saving}
      {running}
      error={selectionError}
      bind:opened={reasoningOpened}
      onopen={() => close()}
      onselect={(reasoningEffort) =>
        selection
          ? choose(
              {
                providerId: selection.providerId,
                modelId: selection.modelId,
                ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
              },
              false,
            )
          : Promise.resolve(false)}
    />{/if}
  {#if opened}<div
      class="model-menu"
      id={`${instanceId}-models`}
      role="group"
      aria-label="对话可用模型"
      popover="manual"
      bind:this={menu}
      style:position-anchor={anchorName}
      use:showMenu
    >
      <header>
        <label class="model-search">
          <svg viewBox="0 0 20 20" aria-hidden="true"
            ><circle cx="8.5" cy="8.5" r="5" /><path d="m12.5 12.5 4 4" /></svg
          >
          <input
            type="search"
            aria-label="搜索模型"
            bind:this={search}
            bind:value={query}
            placeholder="搜索模型或供应商…"
            onkeydown={navigate}
          />
        </label>
        <button
          class="refresh"
          type="button"
          aria-label="刷新模型"
          title="刷新模型"
          disabled={loading || saving}
          onclick={() => void load(true)}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true"
            ><path d="M16 8a6 6 0 0 0-10-3L3 8m0-5v5h5M4 12a6 6 0 0 0 10 3l3-3m0 5v-5h-5" /></svg
          >
        </button>
      </header>
      <div class="model-options">
        {#each groups as group (group.provider.id)}
          <section aria-label={group.provider.name}>
            <p class="provider-name">
              <span>{group.provider.name}</span><span>{group.models.length}</span>
            </p>
            {#each group.models as entry (entry.id)}
              {@const active =
                selection?.providerId === group.provider.id && selection.modelId === entry.id}
              <button
                class="model-option"
                type="button"
                aria-label={entry.id}
                title={entry.id}
                aria-pressed={active}
                disabled={saving}
                onkeydown={navigate}
                onclick={() => {
                  if (active && valid) close(true);
                  else void choose({ providerId: group.provider.id, modelId: entry.id });
                }}
                ><svg class="model-icon" viewBox="0 0 20 20" aria-hidden="true"
                  ><rect x="4" y="4" width="12" height="12" rx="3" /><path d="M7 8h6M7 12h4" /></svg
                ><span class="model-name">{entry.id}</span><svg
                  class:chosen={active}
                  viewBox="0 0 20 20"
                  aria-hidden="true"><path d="m4 10 4 4 8-8" /></svg
                ></button
              >{/each}
          </section>
        {/each}
        {#if loading}<p class="model-state" role="status">正在获取模型…</p>
        {:else if !groups.length}<p class="model-state" role="status">
            {searchQuery ? "没有匹配的模型" : "尚无可用模型，请添加连接或重试获取。"}
          </p>{/if}
      </div>
      {#if running}<p class="next-turn">切换从下一轮生效</p>{/if}
      {#if error}<p class="error" role="alert">{error}</p>{/if}
      <footer>
        <button
          type="button"
          disabled={saving}
          onclick={() => {
            close();
            configure();
          }}>连接设置</button
        >
      </footer>
    </div>{/if}
  {#if !opened && !reasoningOpened && error}<span class="error" role="alert">{error}</span>{/if}
  {#if !loading && selection && !valid}<span class="error" role="status"
      >模型已不可用，请重新选择</span
    >{/if}
</div>

<style>
  .conversation-model {
    display: grid;
    flex: 1;
    grid-template-columns: minmax(0, max-content) max-content;
    align-items: center;
    gap: 4px;
    min-width: 0;
  }
  .conversation-model > .error {
    grid-column: 1 / -1;
  }
  button,
  input {
    font: inherit;
    color: var(--fg);
  }
  button {
    cursor: pointer;
    transition:
      background var(--motion-fast) var(--motion-ease),
      color var(--motion-fast) var(--motion-ease);
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .model-trigger {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    max-width: 100%;
    border: 0;
    background: transparent;
    border-radius: var(--radius-control);
    min-height: 28px;
    padding: 4px 6px;
    font-size: 12px;
    color: var(--muted);
  }
  .model-trigger:hover:not(:disabled) {
    background: var(--control-hover, var(--selected));
    color: var(--fg);
  }
  .model-trigger[aria-expanded="true"] {
    background: var(--selected);
    color: var(--fg);
  }
  .model-trigger:focus-visible {
    outline-offset: -1px;
  }
  .model-trigger span:first-child {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .model-trigger > svg {
    width: 12px;
    height: 12px;
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
  .conversation-model .model-menu {
    --menu-width: min(304px, calc(100vw - 24px));
    position: fixed;
    inset: auto;
    position-area: top span-all;
    position-try-fallbacks: flip-block;
    left: clamp(12px, anchor(left), calc(100vw - var(--menu-width) - 12px));
    justify-self: start;
    margin: 0 0 8px;
    width: var(--menu-width);
    max-height: min(360px, calc(100dvh - 24px));
    box-sizing: border-box;
    padding: 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius-panel);
    background: var(--surface);
    color: var(--fg);
    box-shadow: var(--shadow-popover);
    backdrop-filter: none;
    overflow: hidden;
  }
  .model-menu:popover-open {
    display: flex;
    flex-direction: column;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 4px;
    padding: 2px 2px 6px;
    margin-bottom: 4px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .refresh {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    flex-shrink: 0;
    border: 0;
    border-radius: var(--radius-control);
    background: transparent;
    color: var(--muted);
  }
  .refresh:hover {
    background: var(--selected);
  }
  .model-search {
    display: flex;
    flex: 1;
    min-width: 0;
    align-items: center;
    gap: 7px;
    padding: 5px 7px;
    border: 1px solid transparent;
    border-radius: var(--radius-control);
    background: var(--bg);
    color: var(--muted);
    transition: border-color var(--motion-fast) var(--motion-ease);
  }
  .model-search:focus-within {
    border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
  }
  input {
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
    padding: 0;
    border: 0;
    background: transparent;
    font-size: 12px;
  }
  input::placeholder {
    color: var(--muted);
    opacity: 1;
  }
  input:focus-visible {
    outline: none;
    box-shadow: none;
  }
  .model-options {
    min-height: 0;
    max-height: 248px;
    overflow: auto;
    scrollbar-width: thin;
    overscroll-behavior: contain;
    padding: 0 2px 4px;
  }
  .model-options section + section {
    margin-top: 4px;
  }
  .model-option {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    text-align: left;
    min-height: 34px;
    padding: 6px 8px;
    border: 0;
    border-radius: var(--radius-control);
    background: transparent;
    font-size: 12px;
  }
  .model-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .model-option svg {
    visibility: hidden;
  }
  .model-option svg.chosen {
    visibility: visible;
    color: var(--accent);
  }
  .model-option .model-icon {
    visibility: visible;
    width: 14px;
    height: 14px;
    color: var(--muted);
  }
  .model-option:hover:not(:disabled) {
    background: var(--control-hover, var(--selected));
  }
  .model-option[aria-pressed="true"] {
    background: var(--selected);
  }
  .model-option:focus-visible {
    outline-offset: -2px;
  }
  p {
    font-size: 11px;
    color: var(--muted);
    margin: 4px 0;
    overflow-wrap: anywhere;
  }
  .provider-name {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 7px 8px 4px;
    margin: 0;
  }
  .provider-name span:first-child {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .provider-name span:last-child {
    font-variant-numeric: tabular-nums;
  }
  .model-state {
    padding: 18px 12px;
    text-align: center;
  }
  .next-turn,
  .model-menu > .error {
    padding: 3px 8px 4px;
  }
  footer {
    display: flex;
    padding: 5px 3px 2px;
    border-top: 1px solid var(--border);
    flex-shrink: 0;
  }
  footer button {
    border: 0;
    background: transparent;
    color: var(--muted);
    font-size: 11px;
    padding: 5px;
    border-radius: var(--radius-control);
  }
  footer button:hover {
    background: var(--selected);
    color: var(--fg);
  }
  .error {
    color: var(--danger);
    font-size: 11px;
    overflow-wrap: anywhere;
  }
  @media (prefers-reduced-motion: reduce) {
    button,
    .model-search {
      transition: none;
    }
  }
</style>
