<script lang="ts">
  let {
    scale,
    disabled = false,
    onChange,
    onFit,
  }: {
    scale: number;
    disabled?: boolean;
    onChange: (scale: number) => void;
    onFit: () => void;
  } = $props();
</script>

<div class="preview-zoom" role="group" aria-label="缩放">
  <button
    type="button"
    aria-label="缩小"
    disabled={disabled || scale <= 0.1}
    onclick={() => onChange(Math.max(0.1, scale / 1.25))}
    ><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h12" /></svg></button
  >
  <button
    class="scale"
    type="button"
    aria-label="原始大小"
    {disabled}
    onclick={() => onChange(1)}
    title="点击恢复 100%">{Math.round(scale * 100)}%</button
  >
  <button
    type="button"
    aria-label="放大"
    disabled={disabled || scale >= 4}
    onclick={() => onChange(Math.min(4, scale * 1.25))}
    ><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h12M10 4v12" /></svg></button
  >
</div>
<button class="fit" type="button" {disabled} onclick={onFit}>适应窗口</button>

<style>
  .preview-zoom {
    display: inline-flex;
    align-items: center;
    flex: 0 0 auto;
    gap: 2px;
    padding: 2px;
    border: 1px solid var(--border);
    border-radius: var(--radius-control);
    background: color-mix(in srgb, var(--fg) 3%, transparent);
  }
  .preview-zoom button,
  .fit {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    height: 26px;
    min-width: 28px;
    padding: 0 6px;
    border: 0;
    border-radius: 4px;
    color: inherit;
    background: transparent;
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  /* 固定数字区的占位，倍率变化只更新读数，不推动相邻操作。 */
  .preview-zoom .scale {
    width: 54px;
    font-variant-numeric: tabular-nums;
  }
  .fit {
    height: 32px;
    padding-inline: 10px;
    white-space: nowrap;
  }
  button:hover:not(:disabled) {
    background: var(--selected);
  }
  button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
  }
  @media (pointer: coarse) {
    .preview-zoom {
      padding: 0;
      border: 0;
      box-shadow: inset 0 0 0 1px var(--border);
    }
    .preview-zoom button,
    .fit {
      min-width: 44px;
      min-height: 44px;
    }
  }
</style>
