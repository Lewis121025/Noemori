import { NativeAgentSession } from "@noemori/agent-node";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { ModelSettings } from "../shared/api";
import { record, text } from "../shared/parse";

/**
 * 使用宿主冻结的目录和构建资产创建资源所有者，不发送模型请求。
 * @param userData 权限记录所在的应用数据目录。
 * @param launcher 构建产物中的终端沙箱启动器。
 * @param workspace 用户明确选择的工作目录。
 * @param model 激活时的模型配置；后续每轮由主进程提供最新配置。
 * @param changed 原生状态变化通知，不携带认证或模型私有载荷。
 * @param attachmentDirectory 本对话已发布附件的只读目录；未发送草稿不在授权范围。
 * @returns 尚未开始生成的原生会话。
 * @throws 目录、运行资产、配置或权限无效时拒绝创建。
 */
export function createNativeSession(
  userData: string,
  launcher: string,
  workspace: string,
  model: ModelSettings,
  changed: () => void,
  label = "工作区助手",
  attachmentDirectory?: string,
): NativeAgentSession {
  const root = realpathSync(workspace);
  const readable_paths = [
    join(homedir(), ".cargo"),
    join(homedir(), ".rustup"),
    join(homedir(), ".local/share/pnpm"),
  ].filter(existsSync);
  if (attachmentDirectory) readable_paths.push(realpathSync(attachmentDirectory));
  const variables: Record<string, string> = {};
  for (const name of ["CARGO_HOME", "RUSTUP_HOME"]) {
    const value = process.env[name];
    if (value && existsSync(value)) {
      readable_paths.push(realpathSync(value));
      variables[name] = value;
    }
  }
  const directory = join(dirname(launcher), "browser");
  const manifest = record(JSON.parse(readFileSync(join(directory, "browser.json"), "utf8")));
  const executable = resolve(directory, text(manifest, "executable"));
  if (!existsSync(executable)) throw new Error("应用浏览器运行材料不完整，请重新构建");
  return new NativeAgentSession(
    JSON.stringify({
      workspace: root,
      shell: process.env["SHELL"] ?? "/bin/sh",
      launcher,
      model,
      ui_label: label,
      ui: {
        executable: join(dirname(launcher), "noemori-ui-runtime"),
        broker_directory: join(userData, "ui"),
        extension_id: "adeahajhgekfhfgimpaokoahfajebajb",
        computer_helper:
          process.platform === "darwin"
            ? join(dirname(launcher), "NoemoriComputerHelper.app")
            : null,
      },
      browser: {
        node: process.execPath,
        worker: join(directory, "browser", "main.js"),
        executable,
        // 浏览器画面由会话浮窗展示，运行与弹窗均不占用用户桌面焦点。
        headless: true,
      },
      permission_store: join(userData, "permissions.json"),
      readable_paths,
      environment: { executable_paths: [], variables },
    }),
    changed,
  );
}
