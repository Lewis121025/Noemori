<script lang="ts">
  /** 应用装配入口：拥有应用生命周期，阅读器通过显式接口参与关闭流程。 */
  import { onMount } from "svelte";
  import ReaderWorkspace from "../features/reader/renderer/ReaderWorkspace.svelte";
  import AppearanceOptions from "./AppearanceOptions.svelte";
  import type { HistoryAction, HistoryAvailability } from "../features/reader/shared/api";
  import { InputHistory } from "./input-history";

  const { app, reader: readerApi } = window.nous;
  let reader: ReaderWorkspace | undefined = $state();
  let historyContext = $state(0);
  let publishedHistory: HistoryAvailability | null = null;
  const inputHistory = new InputHistory(
    () => reader?.historyAvailability() === null,
    refreshHistoryContext,
  );

  function refreshHistoryContext(): void {
    historyContext += 1;
  }

  function executeHistory(action: HistoryAction): void {
    if (!reader?.executeHistory(action)) inputHistory.apply(action);
    refreshHistoryContext();
  }

  $effect(() => {
    // 文档事务由响应式 API 跟踪，辅助输入由各控件历史通知；菜单只投影可用性。
    void historyContext;
    const next = reader?.historyAvailability() ?? inputHistory.availability();
    if (publishedHistory?.undo === next.undo && publishedHistory.redo === next.redo) return;
    publishedHistory = next;
    app.historyChanged(next);
  });

  onMount(() =>
    app.subscribeCommand((command) => {
      if (command === "undo" || command === "redo") {
        executeHistory(command);
      } else reader?.executeCommand(command);
    }),
  );

  onMount(() => inputHistory.bind(document, executeHistory));

  onMount(() =>
    app.subscribeFlushBeforeClose(() => {
      void requestClose();
    }),
  );

  async function requestClose(): Promise<void> {
    const ready = (await reader?.flushBeforeClose()) ?? false;
    if (ready) await app.closeAfterFlush();
    else await app.closeBlocked();
  }
</script>

<svelte:document
  onfocusin={refreshHistoryContext}
  onfocusout={refreshHistoryContext}
  oninput={refreshHistoryContext}
  onselectionchange={refreshHistoryContext}
/>

<ReaderWorkspace api={readerApi} bind:this={reader}>
  {#snippet applicationMenu()}<AppearanceOptions api={app} />{/snippet}
</ReaderWorkspace>
