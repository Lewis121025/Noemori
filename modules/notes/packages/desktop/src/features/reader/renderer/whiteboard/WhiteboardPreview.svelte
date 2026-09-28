<script lang="ts">
  import type { WhiteboardDocument } from "./model";
  import { whiteboardPreview } from "./preview";
  let { board }: { board: WhiteboardDocument } = $props();
</script>

<div use:whiteboardPreview={board}></div>
