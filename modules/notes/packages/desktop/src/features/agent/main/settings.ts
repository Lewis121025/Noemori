import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { safeStorage } from "electron";
import type { ModelSettings, ModelSettingsUpdate, PublicModelSettings } from "../shared/api";
import { parseAuthentication, parseModelSettings, record, text } from "../shared/parse";

/** 模型设置只在主进程解密；界面读取仅得到认证类型与是否已配置。 */
export class AgentSettingsStore {
  private readonly file: string;
  private saving: Promise<void> = Promise.resolve();
  /** 绑定应用数据目录，不读取密钥或启动模型。 */
  constructor(private readonly directory: string) {
    this.file = join(directory, "agent-model.json");
  }

  /** 加载供原生模型使用的私有配置；损坏或不能解密时保留失败。 */
  async load(): Promise<ModelSettings | null> {
    let content: string;
    try {
      content = await readFile(this.file, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
    const stored = record(JSON.parse(content));
    if (stored["version"] !== 1) throw new Error("Agent 模型设置版本不支持");
    const settings = parseModelSettings({
      ...record(stored["settings"]),
      authentication: { type: "none" },
    });
    const cipher = stored["authentication"];
    const authentication =
      cipher === null
        ? { type: "none" as const }
        : parseAuthentication(
            JSON.parse(
              safeStorage.decryptString(Buffer.from(text(stored, "authentication"), "base64")),
            ),
          );
    return { ...settings, authentication };
  }

  /** 返回可见设置，不把认证原文重新交付渲染进程。 */
  async public(): Promise<PublicModelSettings | null> {
    const settings = await this.load();
    return settings === null ? null : project(settings);
  }

  /** 顺序保存配置，临时文件采用私有权限；无法加密时拒绝保存认证。 */
  save(input: ModelSettingsUpdate): Promise<PublicModelSettings> {
    const operation = this.saving.then(async () => {
      const prior = input.authentication === null ? await this.load() : null;
      const authentication = input.authentication ??
        prior?.authentication ?? { type: "none" as const };
      if (authentication.type !== "none" && !safeStorage.isEncryptionAvailable())
        throw new Error("系统安全存储不可用，无法保存模型认证");
      const settings: ModelSettings = { ...input, authentication };
      const { authentication: secret, ...visible } = settings;
      const encrypted =
        secret.type === "none"
          ? null
          : safeStorage.encryptString(JSON.stringify(secret)).toString("base64");
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporary = join(this.directory, `.agent-model-${randomUUID()}`);
      try {
        await writeFile(
          temporary,
          JSON.stringify({ version: 1, settings: visible, authentication: encrypted }),
          { mode: 0o600, flag: "wx" },
        );
        await rename(temporary, this.file);
      } finally {
        await rm(temporary, { force: true });
      }
      return project(settings);
    });
    this.saving = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
}

function project(settings: ModelSettings): PublicModelSettings {
  const { authentication, ...visible } = settings;
  return {
    ...visible,
    authentication: {
      type: authentication.type,
      configured: authentication.type !== "none",
      name: authentication.type === "header" ? authentication.name : "",
      region: authentication.type === "aws" ? authentication.region : "",
    },
  };
}
