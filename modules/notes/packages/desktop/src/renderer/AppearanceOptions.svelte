<script lang="ts">
  /** 应用级外观选择，设置提交成功后才更新选中项。 */
  import { onMount } from "svelte";
  import type { Appearance, AppApi } from "../shared/api";
  let { api }: { api: Pick<AppApi, "appearanceGet" | "appearanceSet"> } = $props();
  const APPEARANCE_OPTIONS: Array<{ value: Appearance; label: string }> = [
    { value: "system", label: "跟随系统" },
    { value: "light", label: "浅色" },
    { value: "dark", label: "深色" },
  ];
  let appearance = $state<Appearance>("system");
  let appearanceBusy = $state(true);
  let appearanceError = $state("");
  onMount(() => {
    void restoreAppearance();
  });
  function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
  async function restoreAppearance(): Promise<void> {
    try {
      appearance = await api.appearanceGet();
    } catch (err) {
      appearanceError = `读取外观设置失败：${errorText(err)}`;
    } finally {
      appearanceBusy = false;
    }
  }

  async function setAppearance(next: Appearance): Promise<void> {
    if (appearanceBusy || appearance === next) return;
    appearanceBusy = true;
    appearanceError = "";
    try {
      await api.appearanceSet(next);
      appearance = next;
    } catch (err) {
      appearanceError = `外观设置未能保存：${errorText(err)}`;
    } finally {
      appearanceBusy = false;
    }
  }
</script>

<fieldset class="appearance-options" disabled={appearanceBusy}>
  <legend>外观</legend>
  {#each APPEARANCE_OPTIONS as option (option.value)}
    <button
      type="button"
      aria-pressed={appearance === option.value}
      onclick={() => void setAppearance(option.value)}
      ><span class="appearance-check" aria-hidden="true"
        >{appearance === option.value ? "✓" : ""}</span
      >{option.label}</button
    >
  {/each}
</fieldset>
{#if appearanceError !== ""}<p class="appearance-error" role="alert">{appearanceError}</p>{/if}

<style>
  .appearance-options {
    margin: 0.35rem 0 0;
    padding: 0.35rem 0 0;
    border: 0;
    border-top: 1px solid var(--border);
  }
  .appearance-options legend {
    padding: 0 0.65rem;
    color: var(--muted);
    font-size: 0.75rem;
  }
  .appearance-check {
    display: inline-block;
    width: 1.25rem;
  }
  .appearance-error {
    color: var(--danger);
    padding: 0 0.65rem;
    font-size: 0.8rem;
    overflow-wrap: anywhere;
  }

  button {
    display: block;
    width: 100%;
    padding: 0.5rem 0.65rem;
    border: 1px solid transparent;
    border-radius: 0.4rem;
    font: inherit;
    color: inherit;
    background: transparent;
    text-align: left;
    cursor: pointer;
  }
  button:hover:not(:disabled) {
    background: var(--selected);
  }
  button:disabled {
    cursor: default;
    opacity: 0.45;
  }
</style>
