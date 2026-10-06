import type { PaneLayout, WorkspaceDestination } from "../../shared/api";
import type { ReaderWorkspaceController } from "./state.svelte";

/** 页面切换只改变工作台目的地；文档、活动栏和模式各自保持。 */
export class WorkspaceSpaces {
  private current = $state<WorkspaceDestination>("document");
  private pending = $state(false);
  private disposed = false;

  /** 保存门禁通过后才发布目的地，失败保留原页面。 */
  constructor(
    private readonly workspace: ReaderWorkspaceController,
    private readonly prepareInput: () => Promise<void>,
    private readonly persist: () => void,
  ) {}

  /** 当前已提交目的地。 */
  get space(): WorkspaceDestination {
    return this.current;
  }
  /** 页面导航在途，不包括正文编辑和搜索。 */
  get changing(): boolean {
    return this.pending;
  }
  /** 所有文件类型都在文档工作台显示。 */
  get documentVisible(): boolean {
    return this.current === "document";
  }

  /** 旧关联页面的白板在文档恢复后迁移；新版目的地优先。 */
  restore(layout: PaneLayout): void {
    if (this.disposed) return;
    this.current =
      layout.destination ??
      (layout.space === "library"
        ? "library"
        : layout.space === "connections" && this.workspace.document.content?.kind !== "whiteboard"
          ? "library"
          : "document");
  }
  /** 卸载后不再提交晚到的导航。 */
  dispose(): void {
    this.disposed = true;
  }
  /** 资料管理保留文档会话。 */
  showLibrary(): Promise<boolean> {
    return this.change("library");
  }
  /** 返回已有文档，不根据文档类型重新读取其他文件。 */
  resumeWriting(): Promise<boolean> {
    return this.change("document");
  }
  /** 文件导航已经完成保存门禁，直接显示文档。 */
  showDocument(): void {
    this.commit("document");
  }

  private commit(destination: WorkspaceDestination): void {
    if (this.disposed || this.current === destination) return;
    this.current = destination;
    this.persist();
  }
  private async change(destination: WorkspaceDestination): Promise<boolean> {
    if (this.disposed || this.pending || this.workspace.switching || this.workspace.copying)
      return false;
    if (this.current === destination) return true;
    this.pending = true;
    try {
      await this.prepareInput();
      if (this.disposed || !(await this.workspace.prepareSpaceChange()) || this.disposed)
        return false;
      this.commit(destination);
      return true;
    } finally {
      this.pending = false;
    }
  }
}
