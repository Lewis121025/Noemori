import type { HistoryAction, HistoryAvailability } from "../features/reader/shared/api";

type TextInput = HTMLInputElement | HTMLTextAreaElement;
/** 原生控件的值与 UTF-16 选区；数字等不支持文本选区的控件使用 null。 */
type InputSnapshot = {
  value: string;
  start: number | null;
  end: number | null;
  direction: "forward" | "backward" | "none" | null;
};
/** 一步用户编辑，撤销与重做共享前后快照，不通过浏览器的全局栈回放。 */
type InputChange = {
  before: InputSnapshot;
  after: InputSnapshot;
};
/** 每个辅助控件独占历史；current 仅用于识别没有 input 事件的程序赋值。 */
type InputSession = {
  current: InputSnapshot;
  pending: InputSnapshot | null;
  undo: InputChange[];
  redo: InputChange[];
  group: { type: string; time: number } | null;
};

function textInput(element: Element | null): TextInput | null {
  if (
    element instanceof HTMLTextAreaElement ||
    (element instanceof HTMLInputElement &&
      ["text", "search", "url", "tel", "email", "password", "number"].includes(element.type))
  )
    return element.disabled || element.readOnly ? null : element;
  return null;
}

function snapshot(input: TextInput): InputSnapshot {
  return {
    value: input.value,
    start: input.selectionStart,
    end: input.selectionEnd,
    direction: input.selectionDirection,
  };
}

/**
 * 辅助文本控件的会话内历史。Chromium 的撤销栈跨控件共享，不能用来执行当前焦点的撤销。
 * @param ownsInput 当前焦点是否由辅助控件拥有；正文与源码编辑器必须返回 false。
 * @param changed 历史变化后通知菜单重新读取，控件值仍由 DOM 与既有 input 绑定持有。
 */
export class InputHistory {
  private sessions = new WeakMap<TextInput, InputSession>();
  private composition: { input: TextInput; before: InputSnapshot; active: boolean } | null = null;
  private compositionTimer: ReturnType<typeof setTimeout> | null = null;
  private replaying = false;

  constructor(
    private readonly ownsInput: () => boolean,
    private readonly changed: () => void,
  ) {}

  /** 当前控件没有历史或仍在组词时两项均禁用，不借用其他控件的记录。 */
  availability(): HistoryAvailability {
    const input = this.activeInput();
    if (!input || this.composition?.active) return { undo: false, redo: false };
    const session = this.session(input);
    return {
      undo:
        session.undo.length > 0 ||
        (this.composition?.input === input && this.composition.before.value !== input.value),
      redo: this.composition?.input !== input && session.redo.length > 0,
    };
  }

  /** 执行当前控件的一步历史并恢复选区；没有历史、只读或组词中均不修改内容。 */
  apply(action: HistoryAction): void {
    const input = this.activeInput();
    if (!input || this.composition?.active) return;
    this.finishComposition();
    const session = this.session(input);
    const from = action === "undo" ? session.undo : session.redo;
    const to = action === "undo" ? session.redo : session.undo;
    const change = from.pop();
    if (!change) return;
    const next = action === "undo" ? change.before : change.after;
    to.push(change);
    input.value = next.value;
    if (next.start !== null && next.end !== null)
      input.setSelectionRange(next.start, next.end, next.direction ?? "none");
    session.current = snapshot(input);
    session.pending = null;
    this.closeGroup(input);
    this.replaying = true;
    try {
      // 通过原控件的绑定通知业务，不直接改写搜索词、链接草稿或文件名称状态。
      input.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: action === "undo" ? "historyUndo" : "historyRedo",
        }),
      );
    } finally {
      this.replaying = false;
      this.changed();
    }
  }

  /**
   * 捕获输入前后的值与选区；原生历史事件按当前焦点统一路由，不能按浏览器旧记录的目标执行。
   * @param root 当前页面；仅绑定一次，返回的清理函数用于卸载。
   * @param history 正文、源码和辅助控件共用的历史入口，负责组词与切换门禁。
   */
  bind(root: Document, history: (action: HistoryAction) => void): () => void {
    const controller = new AbortController();
    const options = { capture: true, signal: controller.signal };
    root.addEventListener(
      "focusin",
      () => {
        const input = this.activeInput();
        if (input) this.session(input);
      },
      options,
    );
    root.addEventListener(
      "focusout",
      (event) => {
        if (event.target instanceof Element) {
          const input = textInput(event.target);
          if (input) this.closeGroup(input);
          if (this.composition?.input === input) this.finishComposition();
        }
      },
      options,
    );
    root.addEventListener("beforeinput", (event) => this.beforeInput(event, history), options);
    root.addEventListener("input", (event) => this.commitInput(event), options);
    root.addEventListener(
      "close",
      (event) => {
        // 文件操作对话框会复用 DOM；取消后重新打开属于新草稿，不能重做已放弃的名称。
        if (event.target instanceof HTMLDialogElement) this.releaseControls(event.target);
      },
      options,
    );
    root.addEventListener(
      "compositionstart",
      (event) => {
        const input = this.activeInput();
        if (!input || event.target !== input) return;
        this.finishComposition();
        this.session(input);
        this.composition = { input, before: snapshot(input), active: true };
      },
      options,
    );
    root.addEventListener(
      "compositionend",
      () => {
        if (!this.composition) return;
        this.composition.active = false;
        // 同一轮确认还可能发出最后一个 input；先完成原生组词，再合并成一步撤销。
        this.compositionTimer = setTimeout(() => this.finishComposition(), 0);
      },
      options,
    );
    root.addEventListener("keydown", (event) => this.keyDown(event, history), options);
    root.addEventListener(
      "pointerdown",
      () => {
        const input = this.activeInput();
        if (input) this.closeGroup(input);
      },
      options,
    );
    return () => {
      controller.abort();
      if (this.compositionTimer !== null) clearTimeout(this.compositionTimer);
      this.compositionTimer = null;
      this.composition = null;
      this.sessions = new WeakMap();
    };
  }

  private beforeInput(event: InputEvent, history: (action: HistoryAction) => void): void {
    if (event.defaultPrevented) return;
    const action =
      event.inputType === "historyUndo"
        ? "undo"
        : event.inputType === "historyRedo"
          ? "redo"
          : null;
    if (action !== null) {
      // 当前正文或源码的事件仍由其编辑器处理；旧原生记录不能绕过当前焦点的历史入口。
      if (this.ownsInput() || event.target !== document.activeElement) {
        event.preventDefault();
        event.stopImmediatePropagation();
        history(action);
      }
      return;
    }
    const input = this.eventInput(event);
    if (input) this.session(input).pending = snapshot(input);
  }

  private commitInput(event: Event): void {
    if (this.replaying) return;
    const input = this.eventInput(event);
    if (!input) return;
    const session = this.sessions.get(input);
    if (!session) return;
    const after = snapshot(input);
    if (this.composition?.input === input) {
      session.current = after;
      session.pending = null;
    } else
      this.record(
        session,
        session.pending ?? session.current,
        after,
        event instanceof InputEvent ? event.inputType : "input",
      );
    this.changed();
  }

  private keyDown(event: KeyboardEvent, history: (action: HistoryAction) => void): void {
    const input = this.activeInput();
    if (!input || event.isComposing || event.keyCode === 229 || this.composition?.active) return;
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && !event.altKey && (key === "z" || key === "y")) {
      event.preventDefault();
      event.stopImmediatePropagation();
      history(key === "y" || event.shiftKey ? "redo" : "undo");
    } else if (event.key.length !== 1 && key !== "backspace" && key !== "delete")
      this.closeGroup(input);
  }

  private activeInput(): TextInput | null {
    return this.ownsInput() ? textInput(document.activeElement) : null;
  }

  private releaseControls(scope: HTMLElement): void {
    for (const input of Array.from(scope.querySelectorAll("input, textarea"))) {
      if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) continue;
      this.sessions.delete(input);
      if (this.composition?.input === input) {
        if (this.compositionTimer !== null) clearTimeout(this.compositionTimer);
        this.compositionTimer = null;
        this.composition = null;
      }
    }
    this.changed();
  }

  private eventInput(event: Event): TextInput | null {
    const input = this.composition?.input ?? this.activeInput();
    return event.target === input ? input : null;
  }

  private session(input: TextInput): InputSession {
    let session = this.sessions.get(input);
    // 程序赋值不是用户编辑；旧历史不能把新初始化的值撤回上一份表单内容。
    if (!session || session.current.value !== input.value) {
      session = { current: snapshot(input), pending: null, undo: [], redo: [], group: null };
      this.sessions.set(input, session);
    }
    return session;
  }

  private record(
    session: InputSession,
    before: InputSnapshot,
    after: InputSnapshot,
    type: string,
  ): void {
    session.current = after;
    session.pending = null;
    if (before.value === after.value) return;
    const previous = session.undo.at(-1);
    const time = Date.now();
    const consecutive =
      ["insertText", "deleteContentBackward", "deleteContentForward"].includes(type) &&
      before.start !== null &&
      before.start === before.end &&
      after.start === after.end;
    if (
      previous &&
      session.redo.length === 0 &&
      consecutive &&
      session.group?.type === type &&
      time - session.group.time < 500 &&
      previous.after.value === before.value &&
      previous.after.start === before.start &&
      previous.after.end === before.end
    ) {
      previous.after = after;
    } else {
      session.undo.push({ before, after });
      // 辅助输入仅保留最近 100 步，与文档编辑器默认的历史深度一致。
      if (session.undo.length > 100) session.undo.shift();
    }
    session.redo = [];
    session.group = consecutive ? { type, time } : null;
  }

  private closeGroup(input: TextInput): void {
    const session = this.sessions.get(input);
    if (session) session.group = null;
  }

  private finishComposition(): void {
    if (this.compositionTimer !== null) clearTimeout(this.compositionTimer);
    this.compositionTimer = null;
    const composition = this.composition;
    if (!composition) return;
    this.composition = null;
    const session = this.sessions.get(composition.input);
    if (session)
      this.record(session, composition.before, snapshot(composition.input), "composition");
    this.changed();
  }
}
