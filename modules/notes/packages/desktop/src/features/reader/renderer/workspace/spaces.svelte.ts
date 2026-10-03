import { untrack } from "svelte";
import type { ReaderSpace } from "../../shared/api";
import { isWhiteboardPath } from "../../shared/whiteboard/model";
import type { ReaderWorkspaceController } from "./state.svelte";

/** 画布复用活动文档；列表与图谱只浏览资料，不替换编辑会话。 */
export type ConnectionView = "boards" | "graph" | "canvas";

/** 关联视图只属于关联页面，避免页面与子视图被分两次提交。 */
type SpaceDestination =
  { space: "writing" | "library" } | { space: "connections"; view: ConnectionView };

/** 页面导航只在保存与目标读取完成后提交；DOM 焦点和布局持久化由宿主负责。 */
export class WorkspaceSpaces {
  private current = $state<SpaceDestination>({ space: "writing" });
  private lastBrowseView: Exclude<ConnectionView, "canvas"> = "boards";
  private pending = $state(false);
  private disposed = false;
  private whiteboard = $derived.by(() => this.workspace.document.content?.kind === "whiteboard");

  /**
   * @param workspace 共用的文档与保存门禁，不另建编辑会话。
   * @param prepareInput 在隐藏控件前提交失焦编辑；组词期间不得强制失焦。
   * @param persist 页面提交后保存布局；宿主负责串行写入及错误提示。
   */
  constructor(
    private readonly workspace: ReaderWorkspaceController,
    private readonly prepareInput: () => Promise<void>,
    private readonly persist: () => void,
  ) {}

  /** 当前已提交的页面，异步读取期间仍指向原页面。 */
  get space(): ReaderSpace {
    return this.current.space;
  }

  /** 仅在关联页面使用；其他页面返回上次浏览视图。 */
  get connectionView(): ConnectionView {
    return this.current.space === "connections" ? this.current.view : this.lastBrowseView;
  }

  /** 覆盖失焦、保存、读取和提交整个切换过程，阻止重复导航。 */
  get changing(): boolean {
    return this.pending;
  }

  /** 写作起点可能暂存白板，只有匹配当前页面的编辑面才接受命令。 */
  get documentVisible(): boolean {
    return this.current.space === "writing"
      ? !this.whiteboard
      : this.current.space === "connections" && this.current.view === "canvas";
  }

  /** @param space 会话页面；先设置浏览页面，文档恢复后再次调用以确定白板归属。 */
  restore(space: ReaderSpace): void {
    if (this.disposed) return;
    this.current =
      space === "library"
        ? { space }
        : space === "connections"
          ? { space, view: this.whiteboard ? "canvas" : this.lastBrowseView }
          : this.documentDestination();
  }

  /** 卸载后停止页面提交；已发起的文档保存仍由工作区完成。 */
  dispose(): void {
    this.disposed = true;
  }

  /** @returns 保存门禁通过时进入资料页面；失败保留原页面，原因由工作区显示。 */
  showLibrary(): Promise<boolean> {
    return this.change({ space: "library" });
  }

  /**
   * @param view 明确指定列表或图谱；省略时重复点击保留当前关联视图。
   * @returns 切换成功或已在目标视图时为 true；保存失败时为 false。
   */
  showConnections(view?: Exclude<ConnectionView, "canvas">): Promise<boolean> {
    const destination: SpaceDestination =
      view === undefined && this.current.space === "connections"
        ? this.current
        : {
            space: "connections",
            view: view ?? (this.whiteboard ? "canvas" : this.lastBrowseView),
          };
    return this.change(destination);
  }

  /** @returns 最近正文读取成功或没有正文可恢复时进入写作；失败保留原画布。 */
  resumeWriting(): Promise<boolean> {
    return this.change({ space: "writing" });
  }

  /** 已完成文件导航后按实际文档归属显示；调用方须已通过该导航的保存门禁。 */
  showDocument(): void {
    this.commit(this.documentDestination());
  }

  /**
   * 文内链接、阅读历史与分栏激活共用归属同步；资料、图谱和列表不跟随后台文档。
   * @returns 页面归属改变时为 true，宿主可据此交接焦点；只追踪活动文档变化。
   */
  followDocument(): boolean {
    const destination = this.documentDestination();
    return untrack(() => {
      if (
        this.pending ||
        this.current.space === "library" ||
        (this.current.space === "connections" && this.current.view !== "canvas")
      )
        return false;
      return this.commit(destination);
    });
  }

  private documentDestination(): SpaceDestination {
    return this.whiteboard ? { space: "connections", view: "canvas" } : { space: "writing" };
  }

  private matches(destination: SpaceDestination): boolean {
    return (
      this.current.space === destination.space &&
      (destination.space !== "connections" || this.connectionView === destination.view)
    );
  }

  private commit(destination: SpaceDestination): boolean {
    if (this.disposed || this.matches(destination)) return false;
    const previousSpace = this.current.space;
    this.current = destination;
    if (destination.space === "connections" && destination.view !== "canvas")
      this.lastBrowseView = destination.view;
    if (previousSpace !== destination.space) this.persist();
    return true;
  }

  private async change(destination: SpaceDestination): Promise<boolean> {
    if (this.disposed || this.pending || this.workspace.switching || this.workspace.copying)
      return false;
    if (this.matches(destination)) return true;
    this.pending = true;
    const origin = { pane: this.workspace.activePane, whiteboard: this.whiteboard };
    let completed = false;
    try {
      await this.prepareInput();
      if (this.disposed) return false;
      const saved = await this.workspace.prepareSpaceChange();
      if (!saved || this.disposed) return false;
      if (destination.space === "writing" && this.whiteboard) {
        const path = this.workspace.recentFiles.find(
          (file) => !isWhiteboardPath(file) && this.workspace.files.includes(file),
        );
        if (path !== undefined) {
          const pane = this.workspace.activePane;
          await pane.openFile(path);
          if (this.workspace.activePane !== pane || pane.document.path !== path) return false;
        }
      }
      if (this.disposed) return false;
      this.commit(destination);
      completed = true;
      return true;
    } finally {
      this.pending = false;
      // 只有文档归属发生变化才补交接；单纯的门禁拒绝必须保留原页面。
      if (
        !completed &&
        !this.disposed &&
        (origin.pane !== this.workspace.activePane || origin.whiteboard !== this.whiteboard)
      )
        this.followDocument();
    }
  }
}
