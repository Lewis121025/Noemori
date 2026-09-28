<script lang="ts">
  import DocumentEditor from "@reader/renderer/components/editors/DocumentEditor.svelte";
  import type { MarkdownEditorApi } from "@reader/renderer/engine/editing/editor-api";

  let {
    register,
    onDirty,
  }: { register: (api: MarkdownEditorApi | null) => void; onDirty: () => void } = $props();
  let readOnly = $state(false);
  let epoch = $state(0);

  /** 在同一文档会话中切换读写，验证历史和选区不会因重建而丢失。 */
  export function setReadOnly(value: boolean): void {
    readOnly = value;
  }

  /** 模拟内容不变的重载，更新所属代次但不重置编辑历史。 */
  export function reloadIdentity(): void {
    epoch += 1;
  }
</script>

<DocumentEditor
  {epoch}
  {readOnly}
  {register}
  {onDirty}
  source={"# 阅读\n\n目标 目标\n\n- [ ] 任务\n\n$x$\n\n> [!note]- 提示\n> 标注正文\n"}
  path="阅读.md"
  mediaIo={{
    resolveLink: async () => null,
    readFile: async () => new Uint8Array(),
    createUrl: () => "",
  }}
  importAttachment={async (name) => ({ path: name, warning: null })}
  onAttachmentReport={() => {}}
  onSave={() => {}}
  onOpenLink={() => {}}
  onOutline={() => {}}
/>
