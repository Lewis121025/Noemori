import { canUseEditingTools } from "../../editor/read-only";
/**
 * Obsidian 方言节点的排版视图：注释、标注、脚注与 Mermaid 图表。
 *
 * 视图只改 DOM 或提交属性事务，源码保真仍由 Markdown 会话负责。
 */
import type { Node as PmNode } from "prosemirror-model";
import { Plugin, PluginKey, TextSelection, type EditorState } from "prosemirror-state";
import {
  Decoration,
  DecorationSet,
  type EditorView,
  type NodeView,
  type NodeViewConstructor,
} from "prosemirror-view";
import { createCompositionGuard, isCompositionKey } from "../../editor/composition";
import { applyMarkdownHistory } from "../../editor/history";
import { focusDocument } from "../../editor/read-only";
import { SourceNodeView } from "./source-node-view";

/** 注释预览只显示原文；编辑复用源码节点的输入生命周期。 */
const createCommentView: NodeViewConstructor = (node, view, getPos, decorations) =>
  new SourceNodeView(
    node,
    view,
    getPos,
    {
      kind: "comment",
      render(dom, source) {
        dom.textContent = `%%${source}%%`;
      },
    },
    decorations,
  );

/** 行内与块级注释的节点视图。 */
export const commentNodeViews: Record<string, NodeViewConstructor> = {
  comment_inline: createCommentView,
  comment_block: createCommentView,
};

/** 标注默认标题：类型首字母大写，与 Obsidian 一致。 */
export function calloutDefaultTitle(kind: string): string {
  return kind === "" ? "" : kind.charAt(0).toUpperCase() + kind.slice(1).toLowerCase();
}

/**
 * 标注：头部是可编辑标题与折叠开关，正文是可编辑内容。
 *
 * 折叠是阅读状态，不改写 `+`/`-` 标记；`-` 只决定初始收起。
 */
class CalloutView implements NodeView {
  readonly dom: HTMLElement;
  readonly contentDOM: HTMLElement;
  private readonly header: HTMLElement;
  private readonly title: HTMLInputElement;
  private readonly fold: HTMLButtonElement;
  private node: PmNode;
  private revealRequest: symbol | undefined;

  constructor(
    node: PmNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
    decorations: readonly Decoration[],
  ) {
    this.node = node;
    this.dom = document.createElement("div");
    this.dom.className = "callout";
    this.header = document.createElement("div");
    this.header.className = "callout-header";
    this.header.contentEditable = "false";
    this.fold = document.createElement("button");
    this.fold.type = "button";
    this.fold.className = "callout-fold";
    this.fold.onclick = () => this.setCollapsed(!this.dom.classList.contains("collapsed"));
    this.title = document.createElement("input");
    this.title.className = "callout-title";
    this.title.spellcheck = false;
    this.bindTitle();
    this.header.append(this.fold, this.title);
    this.contentDOM = document.createElement("div");
    this.contentDOM.className = "callout-content";
    this.dom.append(this.header, this.contentDOM);
    this.sync(node);
    this.setCollapsed(node.attrs["fold"] === "-");
    this.revealSelection(decorations);
  }

  private sync(node: PmNode): void {
    const kind = String(node.attrs["kind"] ?? "note");
    const fold = String(node.attrs["fold"] ?? "");
    const title = String(node.attrs["title"] ?? "");
    this.dom.dataset["callout"] = kind.toLowerCase();
    this.dom.dataset["calloutFold"] = fold;
    this.fold.hidden = fold === "";
    this.title.placeholder = calloutDefaultTitle(kind);
    this.title.readOnly = !this.view.editable || !canUseEditingTools(this.view.state);
    this.title.setAttribute("aria-label", `${calloutDefaultTitle(kind)} 标注标题`);
    if (document.activeElement !== this.title && this.title.value !== title)
      this.title.value = title;
  }

  private setCollapsed(collapsed: boolean): void {
    this.dom.classList.toggle("collapsed", collapsed);
    this.fold.setAttribute("aria-expanded", String(!collapsed));
    this.fold.setAttribute("aria-label", collapsed ? "展开标注" : "收起标注");
  }

  private revealSelection(decorations: readonly Decoration[]): void {
    for (const decoration of decorations) {
      const request: unknown = decoration.spec["calloutReveal"];
      if (typeof request !== "symbol" || request === this.revealRequest) continue;
      this.revealRequest = request;
      this.setCollapsed(false);
    }
  }

  /** 标题输入实时写入属性；Enter/Esc/↓ 回到正文开头，保存与撤销交回编辑器。 */
  private bindTitle(): void {
    const composition = createCompositionGuard();
    composition.bind(this.title);
    this.title.addEventListener("input", () => {
      const pos = this.getPos();
      if (!this.view.editable || !canUseEditingTools(this.view.state)) {
        this.title.value = String(this.node.attrs["title"] ?? "");
        return;
      }
      if (pos === undefined || this.node.attrs["title"] === this.title.value) return;
      this.view.dispatch(this.view.state.tr.setNodeAttribute(pos, "title", this.title.value));
    });
    this.title.addEventListener("beforeinput", (event) => {
      if (!(event instanceof InputEvent)) return;
      const action =
        event.inputType === "historyUndo"
          ? "undo"
          : event.inputType === "historyRedo"
            ? "redo"
            : null;
      if (action === null) return;
      event.preventDefault();
      if (!composition.active) applyMarkdownHistory(this.view, action);
    });
    this.title.addEventListener("keydown", (event) => {
      if (composition.active || isCompositionKey(event)) return;
      const modifier = event.metaKey || event.ctrlKey;
      if (modifier && !event.altKey && ["s", "z", "y"].includes(event.key.toLowerCase())) {
        event.preventDefault();
        this.view.someProp("handleKeyDown", (handle) => handle(this.view, event));
        return;
      }
      if (event.key !== "Enter" && event.key !== "Escape" && event.key !== "ArrowDown") return;
      event.preventDefault();
      const pos = this.getPos();
      if (pos === undefined) return;
      const { state } = this.view;
      this.view.dispatch(
        state.tr.setSelection(TextSelection.near(state.doc.resolve(pos + 1))).scrollIntoView(),
      );
      focusDocument(this.view);
    });
  }

  update(node: PmNode, decorations: readonly Decoration[]): boolean {
    if (node.type !== this.node.type) return false;
    const refold = node.attrs["fold"] !== this.node.attrs["fold"];
    this.node = node;
    this.sync(node);
    if (refold) this.setCollapsed(node.attrs["fold"] === "-");
    this.revealSelection(decorations);
    return true;
  }

  stopEvent(event: Event): boolean {
    return event.target instanceof Node && this.header.contains(event.target);
  }

  ignoreMutation(mutation: MutationRecord | { type: "selection"; target: Node }): boolean {
    if (mutation.type === "selection") return false;
    return (
      this.header.contains(mutation.target) ||
      (mutation.type === "attributes" && mutation.target === this.dom)
    );
  }
}

/** 标注节点视图。 */
export const calloutNodeViews: Record<string, NodeViewConstructor> = {
  callout: (node, view, getPos, decorations) => new CalloutView(node, view, getPos, decorations),
};

const calloutRevealKey = new PluginKey<DecorationSet>("callout-reveal");

/**
 * 显式定位选区时，在布局与滚动前展开目标的所有祖先标注。
 * @returns 只提供节点装饰的插件；初始折叠、普通查询更新与手动收起不触发展开，也不改写文档。
 */
export function calloutRevealPlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: calloutRevealKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, previous, _old, state) {
        if (!tr.scrolledIntoView)
          return tr.docChanged ? previous.map(tr.mapping, state.doc) : previous;
        const decorations: Decoration[] = [];
        const { $head } = state.selection;
        // 每次定位都是独立请求：手动收起后再次定位同一命中，也必须重新展开。
        const request = Symbol();
        for (let depth = $head.depth; depth > 0; depth--) {
          const node = $head.node(depth);
          if (node.type.name !== "callout") continue;
          const start = $head.before(depth);
          decorations.push(
            Decoration.node(start, start + node.nodeSize, {}, { calloutReveal: request }),
          );
        }
        return DecorationSet.create(state.doc, decorations);
      },
    },
    props: {
      decorations: (state) => calloutRevealKey.getState(state) ?? DecorationSet.empty,
    },
  });
}

/** Mermaid 图表渲染器；测试注入替身，生产环境按需加载 mermaid。 */
export type MermaidRenderer = (id: string, source: string, dark: boolean) => Promise<string>;

let mermaidSequence = 0;
let initializedTheme: string | null = null;

/** 按需加载 mermaid 并以严格安全级别渲染；主题随系统外观切换时重新初始化。 */
const renderMermaid: MermaidRenderer = async (id, source, dark) => {
  const mermaid = (await import("mermaid")).default;
  const theme = dark ? "dark" : "default";
  if (initializedTheme !== theme) {
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme });
    initializedTheme = theme;
  }
  return (await mermaid.render(id, source)).svg;
};

/** 源码停止变化后再重排，连续输入不会为每个按键跑一次布局。 */
const MERMAID_DEBOUNCE_MS = 250;

/**
 * `mermaid` 代码块：上方是图表预览，下方是可编辑源码。
 *
 * 光标在块内时由装饰插件加上 `code-active`，源码才显示；点击预览把光标放进源码。
 */
class MermaidView implements NodeView {
  readonly dom: HTMLElement;
  readonly contentDOM: HTMLElement;
  private readonly preview: HTMLElement;
  private source: string;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;

  constructor(
    private node: PmNode,
    private readonly view: EditorView,
    private readonly getPos: () => number | undefined,
    private readonly render: MermaidRenderer,
  ) {
    this.dom = document.createElement("div");
    this.dom.className = "mermaid-block";
    this.preview = document.createElement("div");
    this.preview.className = "mermaid-preview";
    this.preview.contentEditable = "false";
    this.syncAccess();
    this.preview.addEventListener("mousedown", (event) => {
      event.preventDefault();
      this.editSource();
    });
    const pre = document.createElement("pre");
    pre.className = "mermaid-source";
    this.contentDOM = document.createElement("code");
    pre.append(this.contentDOM);
    this.dom.append(this.preview, pre);
    this.source = node.textContent;
    this.draw();
  }

  private editSource(): void {
    const pos = this.getPos();
    // 阅读视图只看图表，不展开源码。
    if (pos === undefined || !this.view.editable || !canUseEditingTools(this.view.state)) return;
    const { state } = this.view;
    const end = pos + 1 + this.node.content.size;
    this.view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, end)));
    this.view.focus();
  }

  private syncAccess(): void {
    if (this.view.editable && canUseEditingTools(this.view.state))
      this.preview.title = "点击编辑图表源码";
    else this.preview.removeAttribute("title");
  }

  private schedule(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.draw();
    }, MERMAID_DEBOUNCE_MS);
  }

  private draw(): void {
    const generation = ++this.generation;
    const source = this.source;
    if (source.trim() === "") {
      this.preview.textContent = "空白图表";
      return;
    }
    const dark = globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
    mermaidSequence += 1;
    void this.render(`noemori-mermaid-${String(mermaidSequence)}`, source, dark).then(
      (svg) => {
        if (generation !== this.generation) return;
        this.preview.classList.remove("mermaid-error");
        this.preview.innerHTML = svg;
      },
      (error: unknown) => {
        if (generation !== this.generation) return;
        this.preview.classList.add("mermaid-error");
        this.preview.textContent = `图表无法渲染：${error instanceof Error ? error.message : String(error)}`;
      },
    );
  }

  update(node: PmNode): boolean {
    if (node.type !== this.node.type || node.attrs["params"] !== "mermaid") return false;
    this.node = node;
    if (node.textContent !== this.source) {
      this.source = node.textContent;
      this.schedule();
    }
    this.syncAccess();
    return true;
  }

  stopEvent(event: Event): boolean {
    return event.target instanceof Node && this.preview.contains(event.target);
  }

  ignoreMutation(mutation: MutationRecord | { type: "selection"; target: Node }): boolean {
    if (mutation.type === "selection") return false;
    return (
      this.preview.contains(mutation.target) ||
      (mutation.type === "attributes" && mutation.target === this.dom)
    );
  }

  destroy(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.generation += 1;
  }
}

/** 普通代码块保持 schema 的 `pre > code` 结构，只有 Mermaid 换成预览视图。 */
class CodeBlockView implements NodeView {
  readonly dom: HTMLElement;
  readonly contentDOM: HTMLElement;

  constructor(private readonly type: PmNode["type"]) {
    this.dom = document.createElement("pre");
    this.contentDOM = document.createElement("code");
    this.dom.append(this.contentDOM);
  }

  update(node: PmNode): boolean {
    return node.type === this.type && node.attrs["params"] !== "mermaid";
  }
}

/**
 * 代码块节点视图：语言为 `mermaid` 时渲染图表。
 *
 * @param render 图表渲染器，默认按需加载 mermaid。
 */
export function createCodeBlockViews(
  render: MermaidRenderer = renderMermaid,
): Record<string, NodeViewConstructor> {
  return {
    code_block: (node, view, getPos) =>
      node.attrs["params"] === "mermaid"
        ? new MermaidView(node, view, getPos, render)
        : new CodeBlockView(node.type),
  };
}

const activeCodeKey = new PluginKey<DecorationSet>("mermaid-active");

/** 光标所在的 Mermaid 块加上 `code-active`，源码随之显示，离开后只留图表。 */
export function mermaidFocusPlugin(): Plugin<DecorationSet> {
  const decorate = (state: EditorState): DecorationSet => {
    const { $from } = state.selection;
    for (let depth = $from.depth; depth > 0; depth--) {
      const node = $from.node(depth);
      if (node.type.name === "code_block" && node.attrs["params"] === "mermaid") {
        const start = $from.before(depth);
        return DecorationSet.create(state.doc, [
          Decoration.node(start, start + node.nodeSize, { class: "code-active" }),
        ]);
      }
    }
    return DecorationSet.empty;
  };
  return new Plugin<DecorationSet>({
    key: activeCodeKey,
    state: {
      init: (_config, state) => decorate(state),
      apply: (tr, previous, _old, state) =>
        tr.docChanged || tr.selectionSet ? decorate(state) : previous,
    },
    props: {
      decorations: (state) => activeCodeKey.getState(state) ?? DecorationSet.empty,
    },
  });
}

/**
 * 找到脚注定义的文档位置。
 *
 * @returns 标签大小写不敏感匹配的第一条定义起点；没有定义时为 null。
 */
export function findFootnoteDefinition(doc: PmNode, label: string): number | null {
  const wanted = label.toLowerCase();
  let found: number | null = null;
  doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.type.name === "footnote_def" && String(node.attrs["label"]).toLowerCase() === wanted) {
      found = pos;
      return false;
    }
    return true;
  });
  return found;
}

/** 点击脚注引用跳到定义正文；没有定义时不移动光标。 */
export function footnoteNavigation(): Plugin {
  return new Plugin({
    props: {
      handleClickOn(view, _pos, node) {
        if (node.type.name !== "footnote_ref") return false;
        const target = findFootnoteDefinition(view.state.doc, String(node.attrs["label"]));
        if (target === null) return false;
        const { state } = view;
        view.dispatch(
          state.tr.setSelection(TextSelection.near(state.doc.resolve(target + 1))).scrollIntoView(),
        );
        return true;
      },
    },
  });
}
