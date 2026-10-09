import { afterEach, expect, it, vi } from "vitest";
import { createNativeSession } from "../../../../modules/notes/packages/desktop/src/features/agent/main/native-session";
import type { ModelSettings } from "../../../../modules/notes/packages/desktop/src/features/agent/shared/api";

const native = vi.hoisted(() => ({ configuration: "" }));
vi.mock("../../../../modules/agent/node/index.js", () => ({
  NativeAgentSession: class {
    constructor(configuration: string) {
      native.configuration = configuration;
    }
  },
}));
vi.mock("node:fs", () => ({
  existsSync: () => true,
  realpathSync: (path: string) => path,
  readFileSync: () => JSON.stringify({ executable: "chromium" }),
}));
afterEach(() => vi.unstubAllEnvs());

const model: ModelSettings = {
  protocol: "openai-chat",
  model: "fixture",
  endpoint: "http://127.0.0.1/model",
  authentication: { type: "none" },
  tools: true,
  streaming: false,
  vision: false,
  audio: false,
  video: false,
};

it.each([
  { mode: "hidden", headless: true },
  { mode: undefined, headless: true },
])("窗口模式 $mode 下，Agent 浏览器始终后台运行", ({ mode, headless }) => {
  vi.stubEnv("NOEMORI_TEST_WINDOW", mode);
  createNativeSession("/state", "/runtime/launcher", "/workspace", model, () => {});
  expect(JSON.parse(native.configuration)).toMatchObject({ browser: { headless } });
});
