<script lang="ts">
  import type { Readable } from "svelte/store";
  import type { EditorView } from "prosemirror-view";
  import SelectionFormatting from "@reader/renderer/components/editors/SelectionFormatting.svelte";

  // 模拟文档重新加载：保留工具条组件，只替换编辑器实例。
  let { view }: { view: Readable<EditorView> } = $props();
</script>

<SelectionFormatting view={$view} state={$view.state} blocked={false} onLink={() => {}} />
