<script lang="ts">
  import { newProviderModel, type ProviderModel } from "../shared/providers";
  let { models = $bindable(), changed }: { models: ProviderModel[]; changed: () => void } =
    $props();
</script>

<section aria-label="模型目录">
  <header>
    <h4>模型目录 · {models.length}</h4>
    <button
      type="button"
      onclick={() => {
        models.push(newProviderModel());
        changed();
      }}>手动添加模型</button
    >
  </header>
  {#each models as model, index (model)}
    <div class="model-row">
      <label
        >模型标识<input
          aria-label={`模型标识 ${index + 1}`}
          bind:value={model.id}
          oninput={() => {
            delete model.reasoning;
            delete model.reasoningEffort;
          }}
          placeholder="服务商提供的模型 ID"
          required
        /></label
      >
      <button
        type="button"
        aria-label={`移除模型 ${index + 1}`}
        onclick={() => {
          models.splice(index, 1);
          changed();
        }}>移除</button
      >
      <fieldset>
        <legend>该模型支持的能力</legend>
        <label><input type="checkbox" bind:checked={model.tools} />工具调用</label>
        <label><input type="checkbox" bind:checked={model.streaming} />流式输出</label>
        <label
          >图像<select
            aria-label={`图像能力 ${index + 1}`}
            bind:value={model.vision}
            onchange={changed}
            ><option value={null}>服务商判断</option><option value={true}>支持</option><option
              value={false}>不支持</option
            ></select
          ></label
        >
        <label><input type="checkbox" bind:checked={model.audio} />音频</label>
        <label><input type="checkbox" bind:checked={model.video} />视频</label>
      </fieldset>
    </div>
  {/each}
  <p>模型在对话中选择。接口不支持获取列表时，可在此手动添加。</p>
</section>

<style>
  section {
    display: grid;
    gap: 12px;
  }
  header,
  .model-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }
  header {
    justify-content: space-between;
  }
  h4 {
    margin: 0;
    font-size: 12px;
  }
  .model-row > label {
    flex: 1;
    min-width: 0;
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
    padding: 7px 9px;
    min-width: 0;
  }
  button {
    cursor: pointer;
    font-size: 12px;
  }
  select {
    padding: 3px 6px;
    font-size: 11px;
  }
  fieldset {
    width: 100%;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    border: 0;
    padding: 0;
  }
  fieldset label {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
  }
  legend,
  p {
    font-size: 11px;
    color: var(--muted);
  }
  p {
    margin: 0;
  }
</style>
