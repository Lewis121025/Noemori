/** 侧栏面板只改变辅助内容，保留正文会话和各面板自身状态。 */
export type SidebarPanel = "outline" | "search";

/** 已有独立页面的一级入口，继续经过工作区的保存与切换门禁。 */
type SidebarPageCommand = "open-library";

/** 组件栏只列出现有功能；面板切换与页面导航采用各自明确的执行契约。 */
export type SidebarEntry = {
  label: string;
  icon: string;
} & ({ kind: "panel"; id: SidebarPanel } | { kind: "command"; id: SidebarPageCommand });

/** 一级入口按导航职责排列；网格管理通过文件系统访问，窄侧栏通过横向滚动访问。 */
export const SIDEBAR_COMPONENTS: readonly SidebarEntry[] = [
  {
    kind: "panel",
    id: "outline",
    label: "目录",
    icon: "M9 5h11M9 12h11M9 19h11M3 5h1M3 12h1M3 19h1",
  },
  {
    kind: "panel",
    id: "search",
    label: "搜索",
    icon: "M20 20l-5-5M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0",
  },
  {
    kind: "command",
    id: "open-library",
    label: "文件系统",
    icon: "M3 4h18v16H3zM3 9h18M9 9v11M15 9v11M3 14h18",
  },
];
