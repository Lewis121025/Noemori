<script module lang="ts">
  /** 文件菜单可以发出的管理动作。 */
  export type FileMenuAction =
    | "rename"
    | "move"
    | "trash"
    | "reveal"
    | "export"
    | "conversations"
    | "file"
    | "whiteboard"
    | "directory"
    | "import";
</script>

<script lang="ts">
  import type { VaultEntry } from "../../shared/api";
  import type { LibraryIconName } from "./LibraryIcon.svelte";
  import TreeContextMenu from "./TreeContextMenu.svelte";
  let {
    onAction,
    selectionCount = 0,
    articleConversations = false,
  }: {
    onAction: (action: FileMenuAction, entry: VaultEntry | null) => void;
    selectionCount?: number;
    articleConversations?: boolean;
  } = $props();
  let target = $state<VaultEntry | null>(null);
  let menu: TreeContextMenu;
  const multiple = $derived(selectionCount > 1);
  const items = $derived.by(() => {
    const result: {
      id: FileMenuAction;
      label: string;
      icon: LibraryIconName;
      danger?: boolean;
      separator?: boolean;
    }[] = [];
    if (articleConversations && !multiple && target?.path.toLowerCase().endsWith(".md"))
      result.push({ id: "conversations", label: "查看文章对话", icon: "conversation" });
    if (!multiple && target?.kind === "directory")
      result.push(
        { id: "file", label: "新建笔记…", icon: "note" },
        { id: "whiteboard", label: "新建白板…", icon: "whiteboard" },
        { id: "directory", label: "新建子文件夹…", icon: "folder" },
        { id: "import", label: "导入文件夹…", icon: "import" },
      );
    if (!multiple)
      result.push({
        id: "rename",
        label: "重命名…",
        icon: "rename",
        ...(target?.kind === "directory" ? { separator: true } : {}),
      });
    result.push(
      { id: "move", label: "移动到…", icon: "move" },
      { id: "export", label: "导出…", icon: "export" },
    );
    if (!multiple && target)
      result.push({ id: "reveal", label: "在系统文件夹中显示", icon: "reveal" });
    result.push({
      id: "trash",
      label: "移到废纸篓…",
      icon: "trash",
      danger: true,
      separator: true,
    });
    return result;
  });
  /** 捕获文件目标后打开共用菜单；弹层定位或焦点错误向调用方传播。 */
  export async function open(entry: VaultEntry, x: number, y: number): Promise<void> {
    target = entry;
    await menu.open(x, y);
  }
</script>

<TreeContextMenu
  bind:this={menu}
  {items}
  label="文件操作"
  onAction={(id) => {
    const item = items.find((item) => item.id === id);
    if (item) onAction(item.id, target);
  }}
/>
