import { access, copyFile, chmod, mkdir, rename, writeFile, readFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import type { UiInstallation } from "../shared/api";
import { record, text } from "../shared/values";

/** 完整写入后替换本应用拥有的安装文件，失败清理由同一所有者负责。 */
async function atomic(path: string, bytes: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * 为当前用户登记固定扩展的 Native Messaging 入口，返回用户加载扩展所需目录。
 * @param userData 本应用私有数据目录。
 * @param launcher 已构建终端启动器，用于定位同代 UI 资产。
 * @returns 实际已安装的入口信息，不包含连接密钥。
 * @throws 资产、扩展身份、平台或文件权限无效时失败，不宣称完成安装。
 */
export async function installUiRuntime(
  userData: string,
  launcher: string,
): Promise<UiInstallation> {
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new Error("浏览器连接暂不支持此平台");
  const root = dirname(launcher);
  const extensionDirectory = join(root, "browser-extension");
  const manifest = record(
    JSON.parse(await readFile(join(extensionDirectory, "manifest.json"), "utf8")),
  );
  const digest = createHash("sha256")
    .update(Buffer.from(text(manifest, "key"), "base64"))
    .digest("hex")
    .slice(0, 32);
  const extensionId = [...digest]
    .map((value) => String.fromCharCode(97 + Number.parseInt(value, 16)))
    .join("");
  if (extensionId !== "adeahajhgekfhfgimpaokoahfajebajb")
    throw new Error("扩展身份与原生桥接入口不一致");
  const source = join(root, "noemori-browser-host");
  await access(source, constants.X_OK);
  const directory = join(userData, "ui");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const bridge = join(directory, "noemori-browser-host");
  const temporary = `${bridge}.${randomUUID()}.tmp`;
  try {
    await copyFile(source, temporary);
    await chmod(temporary, 0o755);
    await rename(temporary, bridge);
  } finally {
    await rm(temporary, { force: true });
  }
  const homes =
    process.platform === "darwin"
      ? [
          join(homedir(), "Library/Application Support/Google/Chrome/NativeMessagingHosts"),
          join(homedir(), "Library/Application Support/Microsoft Edge/NativeMessagingHosts"),
        ]
      : [
          join(homedir(), ".config/google-chrome/NativeMessagingHosts"),
          join(homedir(), ".config/microsoft-edge/NativeMessagingHosts"),
        ];
  const body = JSON.stringify({
    name: "app.noemori.browser",
    description: "Noemori 浏览器连接",
    path: bridge,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`],
  });
  for (const home of homes) {
    await mkdir(home, { recursive: true });
    await atomic(join(home, "app.noemori.browser.json"), body);
  }
  return {
    extensionDirectory,
    installed: true,
    computerHelper: process.platform === "darwin" ? join(root, "NoemoriComputerHelper.app") : null,
  };
}
