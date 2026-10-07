<script lang="ts">
  import { untrack } from "svelte";
  import type { Authentication, Protocol } from "../shared/api";
  import { providerPresets } from "../shared/provider-presets";
  import {
    newProviderModel,
    providerEndpoint,
    type ProviderAddress,
    type ProviderUpdate,
    type PublicProvider,
  } from "../shared/providers";
  import ProviderModels from "./ProviderModels.svelte";

  let {
    provider,
    busy,
    save,
    changed,
  }: {
    provider: PublicProvider | null;
    busy: boolean;
    save: (input: ProviderUpdate) => Promise<void>;
    changed: () => void;
  } = $props();
  const original = untrack(() => provider);
  let preset = $state("openai");
  let name = $state(original?.name ?? "OpenAI");
  let protocol = $state<Protocol>(original?.protocol ?? "openai-responses");
  let address = $state<ProviderAddress>(
    original ? { ...original.address } : { type: "base_url", url: "https://api.openai.com/v1" },
  );
  let models = $state(
    original ? original.models.map((model) => ({ ...model })) : [newProviderModel()],
  );
  let kind = $state<Authentication["type"]>(original?.authentication.type ?? "bearer");
  let header = $state(original?.authentication.name ?? "x-api-key");
  let region = $state(original?.authentication.region ?? "");
  let value = $state("");
  let access = $state("");
  let sessionToken = $state("");
  let error = $state("");
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
    changed();
  }
  async function submit(): Promise<void> {
    error = "";
    let authentication: Authentication | null;
    if (kind === "none") authentication = { type: kind };
    else if (retaining && !value && !access && !sessionToken) authentication = null;
    else if (kind === "bearer") authentication = { type: kind, value };
    else if (kind === "header") authentication = { type: kind, name: header, value };
    else
      authentication = {
        type: kind,
        region,
        access_key: access,
        secret_key: value,
        session_token: sessionToken || null,
      };
    try {
      await save({
        id: original?.id ?? null,
        name,
        protocol,
        address: { ...address },
        models: models.map((model) => ({ ...model })),
        authentication,
      });
      value = "";
      access = "";
      sessionToken = "";
    } catch (reason) {
      error = String(reason);
    }
  }
</script>

<form
  oninput={changed}
  onsubmit={(event) => {
    event.preventDefault();
    void submit();
  }}
>
  <fieldset class="form-fields" disabled={busy}>
    <header><h3>{original ? "编辑供应商" : "添加供应商"}</h3></header>
    {#if !original}
      <label
        >供应商预设<select aria-label="供应商预设" bind:value={preset} onchange={applyPreset}
          >{#each providerPresets as item (item.id)}<option value={item.id}>{item.name}</option
            >{/each}</select
        ></label
      >
    {/if}
    <label>名称<input bind:value={name} maxlength="128" required /></label>
    <label
      >{address.type === "base_url" ? "Base URL" : "完整接口地址"}<input
        aria-label="接口地址"
        bind:value={address.url}
        type="url"
        placeholder="https://example.com/v1"
        required
      /></label
    >
    <p>
      {address.type === "base_url"
        ? "填写包含 API 版本的基础地址，保留网关的自定义路径。"
        : "按此地址请求，路径中的 {model} 会替换为所选模型标识。"}
    </p>
    {#if kind !== "none"}
      {#if kind === "aws"}<label
          >Access key<input bind:value={access} autocomplete="off" required={!retaining} /></label
        >{/if}
      <label
        >{kind === "aws" ? "Secret key" : "API Key"}<input
          bind:value
          type="password"
          autocomplete="off"
          required={!retaining}
          placeholder={retaining ? "已设置，留空保留此供应商密钥" : "输入认证材料"}
        /></label
      >
      {#if kind === "aws"}<label
          >Session token（可选）<input
            bind:value={sessionToken}
            type="password"
            autocomplete="off"
          /></label
        >{/if}
    {:else}<p>此供应商使用无认证连接。</p>{/if}
    <button
      class="advanced-toggle"
      type="button"
      aria-expanded={advanced}
      onclick={() => (advanced = !advanced)}>{advanced ? "收起高级设置" : "高级设置"}</button
    >
    {#if advanced}
      <div class="advanced">
        <label
          >协议<select
            aria-label="协议"
            bind:value={protocol}
            onchange={() => {
              if (protocol === "bedrock" || protocol === "vertex-anthropic")
                address.type = "endpoint";
              changed();
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
          >地址模式<select aria-label="地址模式" bind:value={address.type} onchange={changed}
            ><option value="base_url">Base URL（拼接协议路径）</option><option value="endpoint"
              >完整 URL（自定义部署）</option
            ></select
          ></label
        >
        <label
          >请求认证<select aria-label="请求认证" bind:value={kind} onchange={changed}
            ><option value="bearer">Bearer API Key</option><option value="header"
              >API Key 请求头</option
            ><option value="none">无认证</option><option value="aws">AWS SigV4</option></select
          ></label
        >
        {#if kind === "header"}<label>认证请求头<input bind:value={header} required /></label>{/if}
        {#if kind === "aws"}<label>AWS 区域<input bind:value={region} required /></label>{/if}
      </div>
    {/if}
    {#if preview}<p class="preview">请求地址预览：<code>{preview}</code></p>{/if}
    <ProviderModels bind:models {changed} />
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <footer>
      <span>认证材料由系统安全存储加密保存。</span><button type="submit"
        >{busy ? "保存中…" : "保存供应商"}</button
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
  h3 {
    font-size: 14px;
    margin: 0;
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
    justify-self: start;
    font-size: 12px;
  }
  .advanced {
    display: grid;
    gap: 12px;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  p,
  footer span {
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
