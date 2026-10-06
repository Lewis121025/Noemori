import { describe, expect, it } from "vitest";
import {
  READER_COMMANDS,
  acceleratorOf,
  commandAvailable,
  commandForKey,
  commandSpec,
  parseReaderCommand,
  shortcutLabel,
  type CommandContext,
} from "@reader/shared/commands";
import { parseAppCommand } from "../../../../../modules/notes/packages/desktop/src/shared/api";

const key = (value: string, modifiers: Partial<KeyboardEventInit> = {}) => ({
  key: value,
  metaKey: true,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...modifiers,
});

it("不再接受阅读编辑模式切换命令", () => {
  expect(parseReaderCommand("toggle-reading")).toBeNull();
  expect(commandForKey(key("e", { shiftKey: true }))).toBeNull();
});

const ready: CommandContext = {
  vaultOpen: true,
  hasDocument: true,
  canEdit: true,
  markdown: true,
  source: false,
  whiteboard: false,
  canBack: true,
  canForward: true,
};

describe("命令表", () => {
  it("命令 id 与快捷键在表内唯一", () => {
    const ids = READER_COMMANDS.map((command) => command.id);
    expect(new Set(ids).size).toBe(ids.length);
    const shortcuts = READER_COMMANDS.flatMap((command) =>
      command.shortcut === null
        ? []
        : [`${command.shortcut.shift ? "shift+" : ""}${command.shortcut.key}`],
    );
    expect(new Set(shortcuts).size).toBe(shortcuts.length);
  });

  it("白名单只接受表内命令，外壳追加历史动作", () => {
    expect(parseReaderCommand("quick-switcher")).toBe("quick-switcher");
    expect(parseReaderCommand("undo")).toBeNull();
    expect(parseReaderCommand("unknown")).toBeNull();
    expect(parseAppCommand("undo")).toBe("undo");
    expect(parseAppCommand("command-palette")).toBe("command-palette");
    expect(parseAppCommand(5)).toBeNull();
  });

  it("加速键与展示文案从同一份快捷键派生", () => {
    expect(acceleratorOf("open-vault")).toBe("CmdOrCtrl+Shift+O");
    expect(acceleratorOf("toggle-files")).toBe("CmdOrCtrl+\\");
    expect(acceleratorOf("toggle-split")).toBeUndefined();
    expect(shortcutLabel(commandSpec("new-folder").shortcut, true)).toBe("⌘⇧N");
    expect(shortcutLabel(commandSpec("go-back").shortcut, false)).toBe("Ctrl+[");
    expect(shortcutLabel(null, true)).toBe("");
  });
});

describe("按键映射", () => {
  it("Cmd/Ctrl 组合键按表映射，Shift 必须精确一致", () => {
    expect(commandForKey(key("o"))).toBe("quick-switcher");
    expect(commandForKey(key("O", { shiftKey: true }))).toBe("open-vault");
    expect(commandForKey(key("p", { metaKey: false, ctrlKey: true }))).toBe("command-palette");
    expect(commandForKey(key("n", { shiftKey: true }))).toBe("new-folder");
    expect(commandForKey(key("s", { shiftKey: true }))).toBeNull();
    expect(commandForKey(key("e"))).toBe("toggle-source");
    expect(commandForKey(key("g"))).toBeNull();
  });

  it("缺少修饰键或带 Alt 时不触发", () => {
    expect(commandForKey(key("o", { metaKey: false }))).toBeNull();
    expect(commandForKey(key("o", { altKey: true }))).toBeNull();
    expect(commandForKey(key("x"))).toBeNull();
  });
});

it("移除图谱命令后，旧命令输入不能经菜单或命令面板执行", () => {
  expect(parseReaderCommand("open-graph")).toBeNull();
  expect(parseAppCommand("open-graph")).toBeNull();
  expect(READER_COMMANDS.some((command) => command.label.includes("图谱"))).toBe(false);
});

describe("可用性门禁", () => {
  it("编辑能力只取决于文档权限与类型", () => {
    expect(commandAvailable("insert-attachment", ready)).toBe(true);
    expect(commandAvailable("insert-attachment", { ...ready, canEdit: false })).toBe(false);
    expect(commandAvailable("save", ready)).toBe(true);
    expect(commandAvailable("find", ready)).toBe(true);
  });
  it("未打开库时只允许与库无关的命令", () => {
    const closed: CommandContext = {
      vaultOpen: false,
      hasDocument: false,
      canEdit: false,
      markdown: false,
      source: false,
      whiteboard: false,
      canBack: false,
      canForward: false,
    };
    const available = READER_COMMANDS.filter((command) => commandAvailable(command.id, closed)).map(
      (command) => command.id,
    );
    expect(available).toEqual([
      "command-palette",
      "open-settings",
      "open-vault",
      "open-library",
      "new-note",
      "new-whiteboard",
      "toggle-files",
      "toggle-split",
    ]);
  });

  it("文档相关命令随文档状态开关", () => {
    expect(commandAvailable("insert-whiteboard", ready)).toBe(true);
    expect(commandAvailable("insert-whiteboard", { ...ready, source: true })).toBe(false);
    expect(commandAvailable("find", { ...ready, whiteboard: true })).toBe(false);
    expect(commandAvailable("save", ready)).toBe(true);
    expect(commandAvailable("save", { ...ready, canEdit: false })).toBe(false);
    expect(commandAvailable("toggle-source", { ...ready, markdown: false })).toBe(false);
    expect(commandAvailable("go-back", { ...ready, canBack: false })).toBe(false);
    expect(commandAvailable("rename-file", { ...ready, hasDocument: false })).toBe(false);
    expect(commandAvailable("quick-switcher", ready)).toBe(true);
    expect(commandAvailable("bookmark-heading", { ...ready, markdown: false })).toBe(false);
    expect(commandAvailable("bookmark-file", { ...ready, hasDocument: false })).toBe(false);
  });
});
