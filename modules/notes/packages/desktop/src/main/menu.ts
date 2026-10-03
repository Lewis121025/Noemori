import { Menu, type MenuItemConstructorOptions } from "electron";
import type { AppCommand } from "../shared/api";
import type { HistoryAction, HistoryAvailability } from "../features/reader/shared/api";
import { acceleratorOf, commandSpec, type ReaderCommand } from "../features/reader/shared/commands";

/** 应用当前输入表面的历史投影；未就绪、重载或关闭窗口时禁用，菜单尚未安装则忽略。 */
export function updateHistoryMenu(
  availability: HistoryAvailability = { undo: false, redo: false },
): void {
  const menu = Menu.getApplicationMenu();
  for (const action of ["undo", "redo"] as const) {
    const item = menu?.getMenuItemById(action);
    if (item) item.enabled = availability[action];
  }
}

/**
 * 安装桌面原生菜单；历史与文档动作交给当前输入表面，剪贴板与窗口动作使用 Electron role。
 * @param dispatch 将命令交给活动窗口，保存与切换仍由阅读器协调。
 */
export function installApplicationMenu(dispatch: (command: AppCommand) => void): void {
  // 名称与加速键来自命令表；菜单只决定分组与顺序。
  const command = (action: ReaderCommand): MenuItemConstructorOptions => {
    const accelerator = acceleratorOf(action);
    return {
      id: action,
      label: commandSpec(action).label,
      ...(accelerator === undefined ? {} : { accelerator }),
      click: () => dispatch(action),
    };
  };
  const history = (
    label: string,
    accelerator: string,
    action: HistoryAction,
  ): MenuItemConstructorOptions => ({
    id: action,
    label,
    accelerator,
    enabled: false,
    click: () => dispatch(action),
  });
  const template: MenuItemConstructorOptions[] = [
    {
      label: "文件",
      submenu: [
        command("new-note"),
        command("new-whiteboard"),
        command("new-folder"),
        command("open-vault"),
        { type: "separator" },
        command("save"),
        command("export-document"),
        command("export-vault"),
        { role: "close", label: "关闭窗口" },
      ],
    },
    {
      label: "编辑",
      submenu: [
        history("撤销", "CmdOrCtrl+Z", "undo"),
        history("重做", process.platform === "darwin" ? "Cmd+Shift+Z" : "Ctrl+Y", "redo"),
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "selectAll", label: "全选" },
        command("insert-attachment"),
        command("insert-whiteboard"),
        { type: "separator" },
        command("find"),
        command("find-files"),
      ],
    },
    {
      label: "导航",
      submenu: [
        command("open-library"),
        command("quick-switcher"),
        command("command-palette"),
        { type: "separator" },
        command("go-back"),
        command("go-forward"),
        { type: "separator" },
        command("toggle-source"),
        command("toggle-reading"),
      ],
    },
    {
      label: "显示",
      submenu: [
        command("toggle-files"),
        { type: "separator" },
        { role: "resetZoom", label: "实际大小" },
        { role: "zoomIn", label: "放大" },
        { role: "zoomOut", label: "缩小" },
        { role: "togglefullscreen", label: "进入全屏幕" },
      ],
    },
    { role: "windowMenu", label: "窗口" },
  ];
  if (process.platform === "darwin")
    template.unshift({
      label: "Noemori",
      submenu: [
        { role: "about", label: "关于 Noemori" },
        { type: "separator" },
        { role: "services", label: "服务" },
        { type: "separator" },
        { role: "hide", label: "隐藏 Noemori" },
        { role: "hideOthers", label: "隐藏其他" },
        { role: "unhide", label: "显示全部" },
        { type: "separator" },
        { role: "quit", label: "退出 Noemori" },
      ],
    });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
