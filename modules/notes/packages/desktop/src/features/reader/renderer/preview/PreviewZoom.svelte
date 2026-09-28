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

<button
  type="button"
  aria-label="缩小"
  disabled={disabled || scale <= 0.1}
  onclick={() => onChange(Math.max(0.1, scale / 1.25))}>−</button
>
<button
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
  onclick={() => onChange(Math.min(4, scale * 1.25))}>＋</button
>
<button type="button" {disabled} onclick={onFit}>适应窗口</button>
