<script lang="ts">
  import type { Readable } from "svelte/store";
  import type { EditorState } from "prosemirror-state";
  import type { EditorView } from "prosemirror-view";
  import EditorFormatting from "@reader/renderer/components/editors/EditorFormatting.svelte";

  let { view, state }: { view: EditorView; state: Readable<EditorState> } = $props();
</script>

<EditorFormatting {view} state={$state} onLink={() => {}} onAttachment={() => {}} onOpenChange={() => {}} />
