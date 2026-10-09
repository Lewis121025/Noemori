<script lang="ts">
  import type { ReaderWorkspaceController } from "./state.svelte";
  import { VAULT_OPEN_LABELS } from "../../shared/vault-opening";
  let { workspace }: { workspace: ReaderWorkspaceController } = $props();
  const progress = $derived(workspace.openingProgress);
</script>

{#if progress !== null}
  <section class="opening" aria-label="打开资料库">
    <div>
      <p role="status">
        {workspace.cancellingOpen ? "正在取消，请稍候…" : VAULT_OPEN_LABELS[progress.phase]}
      </p>
      {#if progress.total !== null && progress.total > 0}
        <progress
          aria-label={VAULT_OPEN_LABELS[progress.phase]}
          value={progress.completed}
          max={progress.total}
        ></progress>
        <span>{progress.completed} / {progress.total}</span>
      {:else}
        <progress aria-label={VAULT_OPEN_LABELS[progress.phase]}></progress>
      {/if}
    </div>
    <button
      class="reader-button"
      type="button"
      disabled={workspace.cancellingOpen || progress.phase === "committing"}
      onclick={() => void workspace.cancelOpening()}>取消</button
    >
  </section>
{/if}

<style>
  .opening {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--border);
    background: var(--sidebar);
  }
  p {
    margin: 0 0 0.35rem;
  }
  progress {
    width: min(30vw, 18rem);
    vertical-align: middle;
  }
  span {
    margin-left: 0.5rem;
    font-size: 0.8rem;
    color: var(--muted);
  }
</style>
