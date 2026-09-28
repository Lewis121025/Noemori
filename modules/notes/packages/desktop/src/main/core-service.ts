/** 工作线程装配：组合应用会话与功能服务，功能内部不反向依赖外壳。 */
import { createReaderService } from "../features/reader/main/service";
import type { VaultEvent } from "../features/reader/shared/api";
import { loadSession, patchSession, sessionFile, type Session } from "./session";

/**
 * 创建按线程消息顺序执行的服务；原生模块只在工作线程内加载。
 * @param userData 应用数据目录。
 * @param onChanged 阅读器库变更通知。
 * @returns 应用命令与阅读器命令；磁盘及原生模块错误向调用方传播。
 */
export function createCoreService(userData: string, onChanged: (event: VaultEvent) => void) {
  const file = sessionFile(userData);
  const reader = createReaderService(userData, onChanged, {
    load: () => loadSession(file).reader,
    save: (state) => {
      patchSession(file, { reader: state });
    },
  });
  return {
    ...reader,
    sessionLoad: (): Session => loadSession(file),
    sessionPatch: (patch: Partial<Pick<Session, "appearance" | "window">>): void => {
      patchSession(file, patch);
    },
    shutdown: (): void => reader.vaultClose(),
  };
}

/** 工作线程命令由实现签名推导，停机只能经专用 shutdown 消息触发。 */
export type CoreService = Omit<ReturnType<typeof createCoreService>, "shutdown">;
