/**
 * 阅读器命令表：命令 id、中文名与快捷键的唯一事实源。
 *
 * 菜单白名单、原生加速键、工作区快捷键兜底与命令面板都从这张表派生，
 * 新增或改名命令只改这里。撤销/重做属于当前输入表面，不在表内。
 */

/** 快捷键统一带 Cmd（macOS）或 Ctrl（其他平台）修饰；`null` 表示只在命令面板出现。 */
export type Shortcut = { readonly key: string; readonly shift: boolean } | null;

/** 一条命令的静态描述。 */
export type CommandSpec = {
  readonly id: string;
  /** 菜单与命令面板显示的中文名。 */
  readonly label: string;
  readonly shortcut: Shortcut;
};

const cmd = (key: string) => ({ key, shift: false });
const cmdShift = (key: string) => ({ key, shift: true });

/** 全部阅读器命令，顺序即命令面板空查询时的默认顺序。 */
export const READER_COMMANDS = [
  { id: "quick-switcher", label: "快速切换…", shortcut: cmd("o") },
  { id: "command-palette", label: "命令面板…", shortcut: cmd("p") },
  { id: "open-vault", label: "打开笔记库…", shortcut: cmdShift("o") },
  { id: "open-library", label: "资料管理", shortcut: cmdShift("l") },
  { id: "new-note", label: "新建笔记", shortcut: cmd("n") },
  { id: "new-whiteboard", label: "新建白板", shortcut: null },
  { id: "insert-whiteboard", label: "插入白板", shortcut: null },
  { id: "new-folder", label: "新建文件夹", shortcut: cmdShift("n") },
  { id: "save", label: "保存", shortcut: cmd("s") },
  { id: "export-document", label: "导出当前文件…", shortcut: null },
  { id: "export-vault", label: "导出笔记库…", shortcut: null },
  { id: "insert-attachment", label: "插入附件…", shortcut: cmdShift("i") },
  { id: "find", label: "文内查找", shortcut: cmd("f") },
  { id: "find-files", label: "查找文件", shortcut: cmdShift("f") },
  { id: "go-back", label: "后退", shortcut: cmd("[") },
  { id: "go-forward", label: "前进", shortcut: cmd("]") },
  { id: "toggle-source", label: "切换排版/源码视图", shortcut: cmd("e") },
  { id: "toggle-reading", label: "切换阅读 / 编辑模式", shortcut: cmdShift("e") },
  { id: "toggle-files", label: "显示或隐藏文件栏", shortcut: cmd("\\") },
  { id: "toggle-split", label: "切换分栏", shortcut: null },
  { id: "rename-file", label: "重命名当前文件…", shortcut: null },
  { id: "bookmark-file", label: "收藏或取消收藏当前文件", shortcut: null },
  { id: "bookmark-heading", label: "收藏或取消收藏当前标题", shortcut: null },
  { id: "show-bookmarks", label: "显示书签", shortcut: null },
  // 不进原生菜单：菜单加速键会抢走源码视图里 CodeMirror 的「查找下一个」（同为 Mod-g）。
  { id: "open-graph", label: "打开关系图谱", shortcut: cmd("g") },
] as const satisfies readonly CommandSpec[];

/** 阅读器提供的用户动作；外壳可以通过菜单调用，不直接接触编辑状态。 */
export type ReaderCommand = (typeof READER_COMMANDS)[number]["id"];

const byId = new Map<string, CommandSpec>(READER_COMMANDS.map((command) => [command.id, command]));

/**
 * 校验跨进程或外部输入的命令 id。
 *
 * @returns 表内命令；其他值返回 `null`。
 */
export function parseReaderCommand(value: unknown): ReaderCommand | null {
  return READER_COMMANDS.find((command) => command.id === value)?.id ?? null;
}

/** 命令的静态描述；`id` 已受类型约束，必然在表内。 */
export function commandSpec(id: ReaderCommand): CommandSpec {
  const spec = byId.get(id);
  if (spec === undefined) throw new Error(`未注册的命令：${id}`);
  return spec;
}

/**
 * Electron 菜单加速键。
 *
 * @returns 形如 `CmdOrCtrl+Shift+O` 的加速键；面板专属命令返回 `undefined`。
 */
export function acceleratorOf(id: ReaderCommand): string | undefined {
  const shortcut = commandSpec(id).shortcut;
  if (shortcut === null) return undefined;
  return `CmdOrCtrl+${shortcut.shift ? "Shift+" : ""}${shortcut.key.toUpperCase()}`;
}

/**
 * 命令面板里的按键提示。
 *
 * @param mac 是否使用 macOS 符号。
 * @returns 无快捷键时为空串。
 */
export function shortcutLabel(shortcut: Shortcut, mac: boolean): string {
  if (shortcut === null) return "";
  const key = shortcut.key.toUpperCase();
  return mac
    ? `⌘${shortcut.shift ? "⇧" : ""}${key}`
    : `Ctrl+${shortcut.shift ? "Shift+" : ""}${key}`;
}

/** 快捷键匹配所需的按键字段；与 `KeyboardEvent` 同名，便于直接传入事件。 */
export type KeyChord = {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
};

/**
 * 工作区快捷键兜底：菜单加速键被系统消费时（含合成按键）走同一张表。
 *
 * @returns 命中的命令；缺少 Cmd/Ctrl、带 Alt 或 Shift 不一致时返回 `null`。
 */
export function commandForKey(chord: KeyChord): ReaderCommand | null {
  if (chord.altKey || !(chord.metaKey || chord.ctrlKey)) return null;
  const key = chord.key.toLowerCase();
  const hit = READER_COMMANDS.find(
    (command) =>
      command.shortcut !== null &&
      command.shortcut.key === key &&
      command.shortcut.shift === chord.shiftKey,
  );
  return hit?.id ?? null;
}

/** 可用性判断所需的工作区快照；只含布尔事实，门禁逻辑保持纯函数。 */
export type CommandContext = {
  /** 已打开笔记库。 */
  readonly vaultOpen: boolean;
  /** 活动栏有打开的文件。 */
  readonly hasDocument: boolean;
  /** 活动栏文档可编辑。 */
  readonly canEdit: boolean;
  /** 活动栏处于阅读态；允许保存此前的编辑，不允许发起正文写入。 */
  readonly reading: boolean;
  /** 活动栏文档是 Markdown。 */
  readonly markdown: boolean;
  /** 活动栏正在编辑 Markdown 源码，块级插入命令由排版表面提供。 */
  readonly source: boolean;
  /** 白板没有文本查找入口。 */
  readonly whiteboard: boolean;
  /** 活动栏阅读栈可后退。 */
  readonly canBack: boolean;
  /** 活动栏阅读栈可前进。 */
  readonly canForward: boolean;
};

/**
 * 命令当前是否可执行；执行门禁与命令面板的可见性共用这一个判断。
 *
 * 组词、切换等瞬时忙碌状态由执行端统一拦截，不属于这里的静态可用性。
 */
export function commandAvailable(id: ReaderCommand, context: CommandContext): boolean {
  switch (id) {
    case "command-palette":
    case "open-vault":
    case "open-library":
    case "new-note":
    case "new-whiteboard":
    case "toggle-files":
    case "toggle-split":
    case "toggle-reading":
      return true;
    case "quick-switcher":
    case "export-vault":
    case "new-folder":
    case "find-files":
    case "show-bookmarks":
    case "open-graph":
      return context.vaultOpen;
    case "save":
      return context.canEdit;
    case "insert-attachment":
      return context.canEdit && context.markdown && !context.reading;
    case "insert-whiteboard":
      return context.canEdit && context.markdown && !context.reading && !context.source;
    case "find":
      return context.hasDocument && !context.whiteboard;
    case "rename-file":
    case "export-document":
    case "bookmark-file":
      return context.hasDocument;
    case "toggle-source":
      return context.hasDocument && context.markdown && !context.reading;
    case "bookmark-heading":
      return context.hasDocument && context.markdown;
    case "go-back":
      return context.canBack;
    case "go-forward":
      return context.canForward;
  }
}
