<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import type { Authentication, Protocol } from "../shared/api";
  import { providerPresets } from "../shared/provider-presets";
  import {
    providerEndpoint,
    type ProviderAddress,
    type ProviderConnection,
    type DiscoveredModel,
    type ProviderUpdate,
    type PublicProvider,
  } from "../shared/providers";
  import ProviderModels from "./ProviderModels.svelte";

  let {
    provider,
    busy,
    save,
    discover,
    remove,
    changed,
  }: {
    provider: PublicProvider | null;
    busy: boolean;
    save: (input: ProviderUpdate) => Promise<void>;
    discover: (input: ProviderConnection) => Promise<DiscoveredModel[]>;
    remove: () => void;
    changed: () => void;
  } = $props();
  const original = untrack(() => provider);
  const originalPreset = original
    ? providerPresets.find(
        (item) =>
          item.protocol === original.protocol &&
          item.address.type === original.address.type &&
          item.address.url === original.address.url &&
          item.authentication === original.authentication.type &&
          (item.authentication !== "header" || item.header === original.authentication.name),
      )
    : undefined;
  let preset = $state(original ? (originalPreset?.id ?? "custom") : "openai");
  let name = $state(original?.name ?? "OpenAI");
  let protocol = $state<Protocol>(original?.protocol ?? "openai-responses");
  let address = $state<ProviderAddress>(
    original ? { ...original.address } : { type: "base_url", url: "https://api.openai.com/v1" },
  );
  let models = $state(original ? original.models.map((model) => ({ ...model })) : []);
  let kind = $state<Authentication["type"]>(original?.authentication.type ?? "bearer");
  let header = $state(original?.authentication.name ?? "x-api-key");
  let region = $state(original?.authentication.region ?? "");
  let value = $state("");
  let access = $state("");
  let sessionToken = $state("");
  let error = $state("");
  /** 连接编辑或组件释放会使请求版本失效，迟到的结果不能覆盖新连接。 */
  type Discovery =
    | { type: "idle" }
    | { type: "loading" }
    | { type: "ready"; models: DiscoveredModel[] }
    | { type: "error"; message: string };
  let discovery = $state<Discovery>({ type: "idle" });
  let requestVersion = 0;
  const customAddress = $derived(preset === "custom");
  const fetching = $derived(discovery.type === "loading");
  onDestroy(() => {
    requestVersion += 1;
  });
  let advanced = $state(
    original?.authentication.type === "aws" ||
      original?.address.type === "endpoint" ||
      original?.protocol === "vertex-anthropic" ||
      original?.protocol === "bedrock",
  );
  const retaining = $derived(
    Boolean(
      original?.authentication.configured &&
      original.authentication.type === kind &&
      (kind !== "header" || original.authentication.name === header) &&
      (kind !== "aws" || original.authentication.region === region) &&
      sameOrigin(original.address.url, address.url),
    ),
  );
  const canDiscover = $derived.by(() => {
    if (!address.url.trim()) return false;
    if (kind === "none") return true;
    if (retaining && !value && !access && !sessionToken) return true;
    return kind === "aws" ? Boolean(access && value && region) : Boolean(value.trim());
  });
  const preview = $derived.by(() => {
    try {
      return providerEndpoint(protocol, address, models[0]?.id || "{model}");
    } catch {
      return "";
    }
  });

  function sameOrigin(first: string, second: string): boolean {
    try {
      return new URL(first).origin === new URL(second).origin;
    } catch {
      return false;
    }
  }
  function applyPreset(): void {
    const selected = providerPresets.find((item) => item.id === preset);
    if (!selected) return;
    name = selected.name;
    protocol = selected.protocol;
    address = { ...selected.address };
    kind = selected.authentication;
    header = selected.header;
    value = "";
    access = "";
    sessionToken = "";
    region = "";
    connectionChanged();
  }
  function connectionChanged(): void {
    requestVersion += 1;
    discovery = { type: "idle" };
    models = [];
    error = "";
    changed();
  }
  function authentication(): Authentication | null {
    if (kind === "none") return { type: kind };
    if (retaining && !value && !access && !sessionToken) return null;
    if (kind === "bearer") return { type: kind, value };
    if (kind === "header") return { type: kind, name: header, value };
    return {
      type: kind,
      region,
      access_key: access,
      secret_key: value,
      session_token: sessionToken || null,
    };
  }
  async function fetchModels(): Promise<void> {
    const version = ++requestVersion;
    discovery = { type: "loading" };
    try {
      const found = await discover({
        id: original?.id ?? null,
        protocol,
        address: { ...address },
        authentication: authentication(),
      });
      if (version !== requestVersion) return;
      discovery = { type: "ready", models: found };
      models = found;
      changed();
    } catch (reason) {
      if (version === requestVersion) discovery = { type: "error", message: String(reason) };
    }
  }
  async function submit(): Promise<void> {
    if (fetching) return;
    error = "";
    try {
      // 嵌套模型能力也属于响应式状态；提交快照才能安全跨越 Electron IPC。
      await save(
        $state.snapshot({
          id: original?.id ?? null,
          name,
          protocol,
          address,
          models,
          authentication: authentication(),
        }),
      );
      value = "";
      access = "";
      sessionToken = "";
    } catch (reason) {
      error = String(reason);
    }
  }
</script>

{#snippet addressInput()}
  <label
    >{address.type === "base_url" ? "接口地址" : "完整接口地址"}<input
      aria-label="接口地址"
      bind:value={address.url}
      oninput={connectionChanged}
      type="url"
      placeholder="https://example.com/v1"
      required
    /></label
  >
  {#if advanced}<p>
      {address.type === "base_url"
        ? "填写包含 API 版本的基础地址，保留网关的自定义路径。"
        : "按此地址请求，路径中的 {model} 会替换为所选模型标识。"}
    </p>{/if}
{/snippet}

<form
  oninput={changed}
  onsubmit={(event) => {
    event.preventDefault();
    void submit();
  }}
>
  <fieldset class="form-fields" disabled={busy}>
    {#if !original}
      <label
        >供应商<select aria-label="供应商预设" bind:value={preset} onchange={applyPreset}
          >{#each providerPresets as item (item.id)}<option value={item.id}>{item.name}</option
            >{/each}</select
        ></label
      >
    {/if}
    {#if customAddress}{@render addressInput()}{/if}
    {#if kind !== "none"}
      {#if kind === "aws"}<label
          >Access key<input
            bind:value={access}
            oninput={connectionChanged}
            autocomplete="off"
            required={!retaining}
          /></label
        >{/if}
      <label
        >{kind === "aws" ? "Secret key" : "API Key"}<input
          bind:value
          oninput={connectionChanged}
          type="password"
          autocomplete="off"
          required={!retaining}
          placeholder={retaining
            ? "已保存，留空保留"
            : kind === "aws"
              ? "填入 Secret key"
              : "填入 API Key"}
        /></label
      >
      {#if kind === "aws"}<label
          >Session token（可选）<input
            bind:value={sessionToken}
            oninput={connectionChanged}
            type="password"
            autocomplete="off"
          /></label
        >{/if}
    {/if}
    {#if discovery.type === "error"}<p class="error" role="alert">{discovery.message}</p>{/if}
    {#if advanced}<button
        class="fetch-models"
        type="button"
        disabled={fetching || !canDiscover}
        onclick={() => void fetchModels()}>{fetching ? "正在获取模型…" : "获取模型"}</button
      >
      <ProviderModels bind:models {changed} />
    {/if}
    {#if advanced}
      <div class="advanced">
        <label>名称<input bind:value={name} maxlength="128" required /></label>
        {#if !customAddress}{@render addressInput()}{/if}
        <label
          >协议<select
            aria-label="协议"
            bind:value={protocol}
            onchange={() => {
              if (protocol === "bedrock" || protocol === "vertex-anthropic")
                address.type = "endpoint";
              connectionChanged();
            }}
          >
            <option value="openai-responses">OpenAI Responses</option><option value="openai-chat"
              >OpenAI 兼容 Chat</option
            ><option value="anthropic">Anthropic</option><option value="gemini">Gemini</option
            ><option value="ollama">Ollama</option><option value="vertex-anthropic"
              >Vertex Anthropic</option
            ><option value="bedrock">Bedrock</option>
          </select></label
        >
        <label
          >地址模式<select
            aria-label="地址模式"
            bind:value={address.type}
            onchange={connectionChanged}
            ><option value="base_url">Base URL（拼接协议路径）</option><option value="endpoint"
              >完整 URL（自定义部署）</option
            ></select
          ></label
        >
        <label
          >请求认证<select aria-label="请求认证" bind:value={kind} onchange={connectionChanged}
            ><option value="bearer">Bearer API Key</option><option value="header"
              >API Key 请求头</option
            ><option value="none">无认证</option><option value="aws">AWS SigV4</option></select
          ></label
        >
        {#if kind === "header"}<label
            >认证请求头<input bind:value={header} oninput={connectionChanged} required /></label
          >{/if}
        {#if kind === "aws"}<label
            >AWS 区域<input bind:value={region} oninput={connectionChanged} required /></label
          >{/if}
        {#if preview}<p class="preview">请求地址预览：<code>{preview}</code></p>{/if}
        {#if original}<button class="delete" type="button" aria-label="删除供应商" onclick={remove}
            >删除此连接</button
          >{/if}
      </div>
    {/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <footer>
      <button
        class="advanced-toggle"
        type="button"
        aria-expanded={advanced}
        onclick={() => (advanced = !advanced)}>{advanced ? "收起高级设置" : "高级设置"}</button
      >
      <button
        class="save"
        type="submit"
        aria-label="保存供应商"
        disabled={fetching || !canDiscover || models.some((model) => !model.id.trim())}
        >{busy ? "保存中…" : "保存"}</button
      >
    </footer>
  </fieldset>
</form>

<style>
  form,
  .form-fields {
    min-width: 0;
  }
  .form-fields {
    display: grid;
    gap: 14px;
    border: 0;
    margin: 0;
    padding: 0;
  }
  label {
    display: grid;
    gap: 5px;
    font-size: 12px;
  }
  input,
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
  }
  button:disabled {
    opacity: 0.5;
  }
  .advanced-toggle {
    border: 0;
    background: transparent;
    color: var(--muted);
    padding-left: 0;
    font-size: 12px;
  }
  .fetch-models,
  .delete {
    justify-self: start;
    font-size: 12px;
  }
  .delete {
    color: var(--danger);
    border: 0;
    background: transparent;
    padding: 0;
  }
  .save {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-text);
  }
  .advanced {
    display: grid;
    gap: 12px;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  p {
    color: var(--muted);
    font-size: 12px;
    margin: 0;
    line-height: 1.5;
  }
  .preview {
    overflow-wrap: anywhere;
  }
  code {
    font-size: 11px;
  }
  .error {
    color: var(--danger);
  }
  footer {
    display: flex;
    gap: 12px;
    align-items: center;
    justify-content: space-between;
    margin-top: 4px;
  }
</style>
