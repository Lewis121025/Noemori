import { vi } from "vitest";
import type { AppApi } from "../../../../modules/notes/packages/desktop/src/shared/api";
import { DEFAULT_READING_PALETTE } from "@reader/shared/reading-palette";

/**
 * 构造完整的应用桥接替身，完整 App 测试只覆盖自己需要控制的动作。
 * @param overrides 当前用例的行为或故障注入，未覆盖的方法遵循正常默认契约。
 * @returns 每次独立的 AppApi 与调用记录；接口新增必需字段时由类型检查阻止遗漏。
 * @throws 默认实现不抛错，覆盖实现的拒绝沿原 Promise 传播。
 */
export function createAppApiMock(overrides: Partial<AppApi> = {}): AppApi {
  const api: AppApi = {
    historyChanged: vi.fn<AppApi["historyChanged"]>(),
    subscribeCommand: vi.fn<AppApi["subscribeCommand"]>(() => () => {}),
    appearanceGet: vi.fn<AppApi["appearanceGet"]>(async () => "system"),
    appearanceSet: vi.fn<AppApi["appearanceSet"]>(async () => {}),
    readingFontGet: vi.fn<AppApi["readingFontGet"]>(async () => "lora"),
    readingFontSet: vi.fn<AppApi["readingFontSet"]>(async () => {}),
    readingPaletteGet: vi.fn<AppApi["readingPaletteGet"]>(async () => DEFAULT_READING_PALETTE),
    readingPaletteSet: vi.fn<AppApi["readingPaletteSet"]>(async () => {}),
    subscribeFlushBeforeClose: vi.fn<AppApi["subscribeFlushBeforeClose"]>(() => () => {}),
    closeAfterFlush: vi.fn<AppApi["closeAfterFlush"]>(async () => {}),
    closeBlocked: vi.fn<AppApi["closeBlocked"]>(async () => {}),
  };
  return Object.assign(api, overrides);
}
