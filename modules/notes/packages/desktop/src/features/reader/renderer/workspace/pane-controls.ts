import type { Snippet } from "svelte";

/** 工具由所属文档持有；顶栏显示操作，侧栏显示目录，两者共用原编辑会话。 */
export type PaneControls = {
  toolbar: Snippet;
  outline: Snippet;
};
