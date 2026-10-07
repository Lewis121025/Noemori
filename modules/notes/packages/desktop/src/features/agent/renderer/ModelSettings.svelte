<script lang="ts">
  import { onMount } from "svelte";
  import type {
    AgentApi,
    Authentication,
    ModelSettingsUpdate,
    Protocol,
    PublicModelSettings,
  } from "../shared/api";
  let { api, saved, close }: { api: AgentApi; saved: () => void; close: () => void } = $props();
  let original = $state<PublicModelSettings | null>(null);
  let protocol = $state<Protocol>("openai-responses");
  let model = $state("");
  let endpoint = $state("https://api.openai.com/v1/responses");
  let kind = $state<Authentication["type"]>("bearer");
  let name = $state("x-api-key");
  let region = $state("");
  let value = $state("");
  let access = $state("");
  let sessionToken = $state("");
  let tools = $state(true);
  let streaming = $state(true);
  let vision = $state(false);
  let audio = $state(false);
  let video = $state(false);
  let error = $state("");
  let saving = $state(false);
  onMount(() => {
    void api
      .settingsGet()
      .then((settings) => {
        if (settings) {
          original = settings;
          protocol = settings.protocol;
          model = settings.model;
          endpoint = settings.endpoint;
          kind = settings.authentication.type;
          name = settings.authentication.name;
          region = settings.authentication.region;
          tools = settings.tools;
          streaming = settings.streaming;
          vision = settings.vision;
          audio = settings.audio;
          video = settings.video;
        }
      })
      .catch((reason: unknown) => {
        error = String(reason);
      });
  });
  async function save(): Promise<void> {
    saving = true;
    error = "";
    try {
      let authentication: Authentication | null;
      const unchanged =
        original?.authentication.configured &&
        original.authentication.type === kind &&
        (kind !== "header" || original.authentication.name === name) &&
        (kind !== "aws" || original.authentication.region === region);
      if (kind === "none") authentication = { type: kind };
      else if (unchanged && value === "" && access === "" && sessionToken === "")
        authentication = null;
      else if (kind === "bearer") authentication = { type: kind, value };
      else if (kind === "header") authentication = { type: kind, name, value };
      else
        authentication = {
          type: kind,
          region,
          access_key: access,
          secret_key: value,
          session_token: sessionToken || null,
        };
      const settings: ModelSettingsUpdate = {
        protocol,
        model,
        endpoint,
        authentication,
        tools,
        streaming,
        vision,
        audio,
        video,
      };
      await api.settingsSet(settings);
      value = "";
      access = "";
      sessionToken = "";
      saved();
      close();
    } catch (reason) {
      error = String(reason);
    } finally {
      saving = false;
    }
  }
</script>

<form
  class="model-settings"
  onsubmit={(event) => {
    event.preventDefault();
    void save();
  }}
>
  <header>
    <h3>模型接口</h3>
    <button type="button" onclick={close}>关闭</button>
  </header>
  <label
    >协议<select bind:value={protocol}
      ><option value="openai-responses">OpenAI Responses</option><option value="openai-chat"
        >OpenAI 兼容 Chat</option
      ><option value="anthropic">Anthropic</option><option value="vertex-anthropic"
        >Vertex Anthropic</option
      ><option value="gemini">Gemini</option><option value="ollama">Ollama</option><option
        value="bedrock">Bedrock</option
      ></select
    ></label
  >
  <label>模型标识<input bind:value={model} placeholder="服务商提供的模型名称" required /></label>
  <label>完整接口地址<input bind:value={endpoint} type="url" required /></label>
  <label
    >请求认证<select bind:value={kind}
      ><option value="none">无认证</option><option value="bearer">Bearer</option><option
        value="header">请求头</option
      ><option value="aws">AWS SigV4</option></select
    ></label
  >
  {#if kind === "header"}<label>请求头名称<input bind:value={name} required /></label>{/if}
  {#if kind === "aws"}<label>AWS 区域<input bind:value={region} required /></label><label
      >Access key<input bind:value={access} autocomplete="off" /></label
    >{/if}
  {#if kind !== "none"}<label
      >{kind === "aws" ? "Secret key" : "认证值"}<input
        bind:value
        type="password"
        autocomplete="off"
        placeholder={original?.authentication.configured ? "已设置，留空保留" : "输入认证材料"}
      /></label
    >{/if}
  {#if kind === "aws"}<label
      >Session token（可选）<input
        bind:value={sessionToken}
        type="password"
        autocomplete="off"
      /></label
    >{/if}
  <fieldset>
    <legend>模型支持的能力</legend><label
      ><input type="checkbox" bind:checked={tools} />工具调用</label
    ><label><input type="checkbox" bind:checked={streaming} />流式输出</label><label
      ><input type="checkbox" bind:checked={vision} />图像</label
    ><label><input type="checkbox" bind:checked={audio} />音频</label><label
      ><input type="checkbox" bind:checked={video} />视频</label
    >
  </fieldset>
  <p>新会话使用此设置。认证材料保存在系统安全存储中。</p>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  <button type="submit" disabled={saving}>{saving ? "保存中…" : "保存接口"}</button>
</form>

<style>
  .model-settings {
    display: grid;
    gap: 12px;
    padding: 18px;
    overflow: auto;
    max-height: 100%;
    background: var(--agent-surface, #fff);
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  h3 {
    margin: 0;
  }
  label {
    display: grid;
    gap: 5px;
    font-size: 13px;
  }
  input,
  select,
  button {
    font: inherit;
    color: inherit;
    background: transparent;
    border: 1px solid color-mix(in srgb, currentColor 22%, transparent);
    border-radius: 6px;
    padding: 7px 9px;
  }
  fieldset {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    border: 0;
    padding: 0;
  }
  fieldset label {
    display: flex;
    align-items: center;
    gap: 5px;
  }
  legend {
    font-size: 13px;
    margin-bottom: 8px;
  }
  p {
    font-size: 12px;
    opacity: 0.7;
    margin: 0;
  }
  .error {
    color: #c0392b;
    opacity: 1;
  }
  button {
    cursor: pointer;
  }
</style>
