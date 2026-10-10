<script lang="ts">
  import type { AgentApi, AgentBrowser } from "../shared/api";
  import BrowserWorkspace from "./BrowserWorkspace.svelte";
  let { api, session, browser }: { api: AgentApi; session: string; browser: AgentBrowser } =
    $props();
</script>

{#if browser.status === "human"}
  <BrowserWorkspace {api} {session} {browser} />
{/if}
