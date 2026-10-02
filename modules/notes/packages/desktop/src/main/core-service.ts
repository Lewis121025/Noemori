/** 宿主装配：原生句柄唯一拥有应用运行时，功能层只适配协议。 */
import { createRequire } from "node:module";
import type * as NativeModule from "@noemori/vault-node";
import { createReaderService } from "../features/reader/main/service";
import { parseVaultEvent, type VaultEvent } from "../features/reader/shared/api";
import { parseSession, type Session } from "./session";

const require = createRequire(import.meta.url);

/**
 * 创建直接连接 Rust 的应用服务；所有磁盘操作均返回原生 Promise。
 * @param userData 应用数据目录。
 * @param onChanged 当前库通知；迟到代次在这里丢弃。
 * @returns 应用服务与控制句柄工厂；原生加载和请求错误保留原因。
 */
export function createCoreService(userData: string, onChanged: (event: VaultEvent) => void) {
  const module = require("@noemori/vault-node") as typeof NativeModule;
  const native = new module.NativeRuntime(userData, (event) => {
    if (event.generation !== native.generation) return;
    try {
      onChanged(parseVaultEvent(event));
    } catch (error) {
      onChanged({ status: "index-error", paths: [], message: String(error) });
    }
  });
  return {
    ...createReaderService(native, () => new module.NativeControl()),
    createControl: (): NativeModule.NativeControl => new module.NativeControl(),
    async sessionLoad(): Promise<Session> {
      const session = parseSession(JSON.stringify(await native.sessionLoad()));
      if (session === null) throw new Error("内核会话响应无效");
      return session;
    },
    sessionPatch: (patch: Partial<Pick<Session, "appearance" | "window">>): Promise<void> =>
      native.sessionPatch(patch),
    shutdown: (): Promise<void> => native.shutdown(),
  };
}

/** 命令签名由服务推导，控制与停机不经普通命令入口。 */
export type CoreService = Omit<ReturnType<typeof createCoreService>, "shutdown" | "createControl">;
