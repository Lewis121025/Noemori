<script module lang="ts">
  /** 文件目录使用固定的图形词汇，所有入口共享尺寸、笔画和圆角。 */
  export type LibraryIconName =
    | "folder"
    | "folder-open"
    | "note"
    | "whiteboard"
    | "conversation"
    | "branch"
    | "chevron"
    | "more"
    | "search"
    | "close"
    | "plus"
    | "import"
    | "rename"
    | "move"
    | "export"
    | "reveal"
    | "trash"
    | "archive"
    | "restore"
    | "expand"
    | "collapse"
    | "check";
</script>

<script lang="ts">
  let { name, size = 16 }: { name: LibraryIconName; size?: number } = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.6"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  {#if name === "folder"}
    <path d="M20 20H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2Z" />
  {:else if name === "folder-open"}
    <path
      d="M3 10V6a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v1M4 20h14a2 2 0 0 0 2-1.5l2-6a1 1 0 0 0-1-1.5H6a2 2 0 0 0-2 1.5l-1 6A1 1 0 0 0 4 20Z"
    />
  {:else if name === "note"}
    <rect x="5" y="3" width="14" height="18" rx="2" /><path d="M9 9h6M9 14h4" />
  {:else if name === "whiteboard"}
    <rect x="3" y="3" width="18" height="15" rx="2" /><path d="m8 22 4-4 4 4M7 11l3-3 3 3 4-5" />
  {:else if name === "conversation"}
    <path d="M21 15a3 3 0 0 1-3 3H8l-5 3V6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3Z" />
    <path d="M7 10h10" />
  {:else if name === "branch"}
    <circle cx="6" cy="4" r="1.5" /><circle cx="6" cy="20" r="1.5" /><circle
      cx="18"
      cy="6"
      r="1.5"
    />
    <path d="M6 5.5v13M18 7.5A10.5 10.5 0 0 1 7.5 18H6" />
  {:else if name === "chevron"}<path d="m9 6 6 6-6 6" />
  {:else if name === "more"}
    <circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
    <circle cx="19" cy="12" r="1.5" fill="currentColor" stroke="none" />
  {:else if name === "search"}<circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" />
  {:else if name === "close"}<path d="m6 6 12 12M18 6 6 18" />
  {:else if name === "plus"}<path d="M12 5v14M5 12h14" />
  {:else if name === "import"}<path
      d="M12 3v12m-4-4 4 4 4-4M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"
    />
  {:else if name === "rename"}<path d="m16 3 5 5M3 21l5-1L20 8a3.5 3.5 0 0 0-5-5L3 15Z" />
  {:else if name === "move"}<path
      d="M9 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-4M12 9h10m-4-4 4 4-4 4"
    />
  {:else if name === "export"}<path
      d="M12 16V3m-4 4 4-4 4 4M4 14v6a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-6"
    />
  {:else if name === "reveal"}<path
      d="M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"
    />
  {:else if name === "trash"}<path
      d="M3 6h18M9 6V3h6v3M5 6l1 14a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1l1-14M10 10v7M14 10v7"
    />
  {:else if name === "archive"}<rect x="3" y="3" width="18" height="4" rx="1" /><path
      d="M5 7v13h14V7M10 11h4"
    />
  {:else if name === "restore"}<path d="M3 10a9 9 0 1 1 2 8M3 4v6h6M12 7v5l3 2" />
  {:else if name === "expand"}<path d="m8 8 4-4 4 4m-8 8 4 4 4-4" />
  {:else if name === "collapse"}<path d="m8 4 4 4 4-4m-8 16 4-4 4 4" />
  {:else if name === "check"}<path d="m5 12 4 4L19 6" />{/if}
</svg>

<style>
  svg {
    display: block;
    flex-shrink: 0;
  }
</style>
