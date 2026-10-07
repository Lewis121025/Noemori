<script lang="ts">
  import { newProviderModel, type ProviderModel } from "../shared/providers";
  let { models = $bindable(), changed }: { models: ProviderModel[]; changed: () => void } =
    $props();
</script>

<section aria-label="模型列表">
  <header>
    <h4>模型列表</h4>
    <button
      type="button"
      onclick={() => {
        models.push(newProviderModel());
        changed();
      }}>添加模型</button
    >
  </header>
  {#each models as model, index (model)}
    <div class="model-row">
      <div class="model-id">
        <label
          >模型标识<input
            aria-label={`模型标识 ${index + 1}`}
            bind:value={model.id}
            placeholder="服务商提供的模型 ID"
            required
          /></label
        >
        <button
          type="button"
          aria-label={`移除模型 ${index + 1}`}
          disabled={models.length === 1}
          onclick={() => {
            models.splice(index, 1);
            changed();
          }}>移除</button
        >
      </div>
      <fieldset>
        <legend>该模型支持的能力</legend>
        <label><input type="checkbox" bind:checked={model.tools} />工具调用</label>
        <label><input type="checkbox" bind:checked={model.streaming} />流式输出</label>
        <label><input type="checkbox" bind:checked={model.vision} />图像</label>
        <label><input type="checkbox" bind:checked={model.audio} />音频</label>
        <label><input type="checkbox" bind:checked={model.video} />视频</label>
      </fieldset>
    </div>
  {/each}
  <p>使用服务商实际支持的模型标识和能力。同名模型可属于不同供应商。</p>
</section>

<style>
  section {
    display: grid;
    gap: 12px;
  }
  header,
  .model-id {
    display: flex;
    gap: 10px;
    align-items: center;
    justify-content: space-between;
  }
  h4 {
    margin: 0;
    font-size: 13px;
  }
  .model-row {
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    display: grid;
    gap: 10px;
  }
  .model-id > label {
    flex: 1;
    min-width: 0;
    display: grid;
    gap: 5px;
    font-size: 12px;
  }
  input,
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
  button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  fieldset {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    border: 0;
    padding: 0;
  }
  fieldset label {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
  }
  legend {
    font-size: 11px;
    color: var(--muted);
    margin-bottom: 6px;
  }
  p {
    font-size: 12px;
    color: var(--muted);
    margin: 0;
  }
</style>
