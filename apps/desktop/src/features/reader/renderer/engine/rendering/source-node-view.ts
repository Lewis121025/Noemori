/** 公式、HTML 与注释共用源码编辑和预览生命周期，具体排版与资源由各自的预览实现负责。 */
import type { Node as PmNode, NodeType } from "prosemirror-model";
import type { Decoration, EditorView, NodeView } from "prosemirror-view";
import { bindSourceField, type SourceAttribute } from "./source-field";
import { NodeSelection } from "prosemirror-state";
import { sourceEditingKey } from "../editing/source-editing";

/** 源码节点种类；决定现有 schema 属性、样式类与剪贴板数据属性。 */
export type SourceKind = "math" | "html" | "comment";

/** 各类源码节点的渲染差异；预览只改 DOM，不得提交文档事务。 */
export type SourcePreview = {
  kind: SourceKind;
  /** signal 失效后不得再更新预览，并须释放已获得及迟到的资源。 */
  render: (dom: HTMLElement, source: string, display: boolean, signal: AbortSignal) => void;
};

const SOURCE_ATTRIBUTE: Record<SourceKind, SourceAttribute> = {
  math: "tex",
  html: "html",
  comment: "source",
};
const SOURCE_DATASET: Record<SourceKind, string> = {
  math: "mathTex",
  html: "htmlSrc",
  comment: "commentSrc",
};
const SOURCE_LABEL: Record<SourceKind, string> = { math: "公式", html: "HTML", comment: "注释" };

/** 源码输入实时进入文档；选择保留预览，显式编辑才创建输入框，滚动保持预览不变。 */
export class SourceNodeView implements NodeView {
  readonly dom: HTMLElement;
  private readonly nodeType: NodeType;
  private readonly display: boolean;
  private readonly attribute: SourceAttribute;
  private readonly sourceKey: string;
  private source: string;
  private sourceEl: HTMLInputElement | HTMLTextAreaElement | null = null;
  private previewController: AbortController | null = null;

  /**
   * @param node 当前公式或 HTML 节点，块级形态取自 schema。
   * @param view 所属编辑器；仅源码输入会触发文档事务。
   * @param getPos 获取节点实时位置，避免前文编辑后写错位置。
   * @param preview 该节点的预览实现，取消时负责释放资源。
   * @param decorations 编辑状态装饰，新插入的空公式可直接进入源码。
   */
  constructor(
    node: PmNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
    private readonly preview: SourcePreview,
    decorations: readonly Decoration[] = [],
  ) {
    this.nodeType = node.type;
    this.display = node.isBlock;
    this.attribute = SOURCE_ATTRIBUTE[preview.kind];
    this.sourceKey = SOURCE_DATASET[preview.kind];
    this.source = String(node.attrs[this.attribute] ?? "");
    this.dom = document.createElement(this.display ? "div" : "span");
    this.dom.className = `${preview.kind}-${this.display ? "block" : "inline"}`;
    this.dom.dataset[this.sourceKey] = this.source;
    this.dom.dataset[`${preview.kind}Display`] = String(this.display);
    this.dom.contentEditable = "false";
    this.dom.title = "双击或选中后按 Enter 编辑，Esc 返回正文";
    if (decorations.some((decoration) => decoration.spec["sourceEditing"] === true))
      this.startEditing();
    else this.render();
  }

  selectNode(): void {
    this.dom.classList.add("ProseMirror-selectednode");
  }

  deselectNode(): void {
    this.dom.classList.remove("ProseMirror-selectednode");
    this.stopEditing();
  }

  private startEditing(): void {
    if (this.sourceEl !== null) return;
    // 块级预览切换为源码时保留原占位，避免后续正文突然向上跳动。
    if (this.display) this.dom.style.minHeight = `${this.dom.getBoundingClientRect().height}px`;
    this.cancelPreview();
    const field = this.display
      ? document.createElement("textarea")
      : document.createElement("input");
    field.className = `${this.preview.kind}-source`;
    field.value = this.source;
    const label = SOURCE_LABEL[this.preview.kind];
    field.setAttribute("aria-label", `${this.display ? "块级" : "行内"}${label}源码`);
    field.setAttribute(
      "aria-description",
      this.display
        ? "Esc 返回正文；⌘/Ctrl+Enter 完成并继续写作"
        : "Enter 完成；Esc 返回正文；在输入边界使用方向键离开",
    );
    field.spellcheck = false;
    bindSourceField(field, this.view, this.getPos, this.attribute);
    this.sourceEl = field;
    this.sizeField();
    this.dom.classList.add("source-editing");
    this.dom.replaceChildren(field);
    queueMicrotask(() => {
      // 选择可能在同一轮事务中撤销，失效的输入框不应再请求焦点。
      if (this.sourceEl !== field) return;
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
    });
  }

  private stopEditing(): void {
    if (this.sourceEl === null) return;
    this.sourceEl = null;
    this.dom.style.removeProperty("min-height");
    this.dom.classList.remove("source-editing");
    this.render();
  }

  update(node: PmNode, decorations: readonly Decoration[]): boolean {
    if (node.type !== this.nodeType) return false;
    const next = String(node.attrs[this.attribute] ?? "");
    const changed = next !== this.source;
    this.source = next;
    this.dom.dataset[this.sourceKey] = next;
    if (decorations.some((decoration) => decoration.spec["sourceEditing"] === true)) {
      this.startEditing();
      if (this.sourceEl !== null && this.sourceEl.value !== next) this.sourceEl.value = next;
      this.sizeField();
    } else if (this.sourceEl !== null) this.stopEditing();
    else if (changed) this.render();
    return true;
  }

  private sizeField(): void {
    if (this.sourceEl instanceof HTMLTextAreaElement)
      this.sourceEl.rows = Math.max(3, Math.min(12, this.source.split("\n").length));
    else if (this.sourceEl !== null) this.sourceEl.size = Math.max(4, this.source.length + 1);
  }

  ignoreMutation(): boolean {
    return true;
  }

  stopEvent(event: Event): boolean {
    return (
      this.sourceEl !== null ||
      (event.target instanceof Element && event.target.closest(".source-empty") !== null)
    );
  }

  destroy(): void {
    this.cancelPreview();
    this.sourceEl = null;
  }

  private render(): void {
    this.cancelPreview();
    // 空源码仍是待完成的编辑，恢复后必须能用鼠标或键盘重新进入，不能渲染成零宽节点。
    if (this.source.trim() === "") {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "reader-button source-empty";
      button.textContent = `补充${SOURCE_LABEL[this.preview.kind]}`;
      button.onclick = () => {
        const pos = this.getPos();
        if (pos === undefined || this.view.isDestroyed) return;
        this.view.dispatch(
          this.view.state.tr
            .setSelection(NodeSelection.create(this.view.state.doc, pos))
            .setMeta(sourceEditingKey, true),
        );
      };
      this.dom.replaceChildren(button);
      return;
    }
    this.previewController = new AbortController();
    this.preview.render(this.dom, this.source, this.display, this.previewController.signal);
  }

  private cancelPreview(): void {
    this.previewController?.abort();
    this.previewController = null;
  }
}
