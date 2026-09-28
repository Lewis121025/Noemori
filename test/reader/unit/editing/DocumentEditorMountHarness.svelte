<script lang="ts">
  /**
   * 复现 App 外壳：挂载写大纲 → 父状态变 → 再渲染。
   */
  import DocumentEditor from "@reader/renderer/components/editors/DocumentEditor.svelte";
  import type { MarkdownEditorApi } from "@reader/renderer/engine/editing/editor-api";
  import { outlineEquals, type OutlineItem } from "@reader/renderer/engine/navigation/outline";

  type Props = {
    onRegister: (api: MarkdownEditorApi | null) => void;
  };

  let { onRegister }: Props = $props();
  let outline = $state<OutlineItem[]>([]);

  function markDirty(): void {}
  function requestSave(): void {}
  function requestOpenLink(_kind: "wiki" | "md", _raw: string): void {}

  function setOutline(items: OutlineItem[]): void {
    if (outlineEquals(outline, items)) {
      return;
    }
    outline = items;
  }
</script>

<DocumentEditor
  mediaIo={{
    resolveLink: async () => null,
    readFile: async () => new Uint8Array(),
    createUrl: () => "",
  }}
  path="Note.md"
  importAttachment={async (name) => ({ path: `attachments/${name}`, warning: null })}
  onAttachmentReport={() => {}}
  source={"# Hi\n"}
  onDirty={markDirty}
  onSave={requestSave}
  onOpenLink={requestOpenLink}
  onOutline={setOutline}
  register={onRegister}
/>
