import type { Authentication, Protocol } from "./api";
import type { ProviderAddress } from "./providers";

/** 预设仅提供已知的协议和连接方式；模型标识由服务商或用户提供。 */
export type ProviderPreset = {
  id: string;
  name: string;
  protocol: Protocol;
  address: ProviderAddress;
  authentication: Authentication["type"];
  header: string;
};

/** 版本路径明确放在 Base URL 中，避免网关和本地服务被隐式改写。 */
export const providerPresets: readonly ProviderPreset[] = [
  {
    id: "openai",
    name: "OpenAI",
    protocol: "openai-responses",
    address: { type: "base_url", url: "https://api.openai.com/v1" },
    authentication: "bearer",
    header: "",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    protocol: "anthropic",
    address: { type: "base_url", url: "https://api.anthropic.com/v1" },
    authentication: "header",
    header: "x-api-key",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    protocol: "gemini",
    address: { type: "base_url", url: "https://generativelanguage.googleapis.com/v1beta" },
    authentication: "header",
    header: "x-goog-api-key",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    protocol: "openai-chat",
    address: { type: "base_url", url: "https://api.deepseek.com" },
    authentication: "bearer",
    header: "",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    protocol: "openai-chat",
    address: { type: "base_url", url: "https://openrouter.ai/api/v1" },
    authentication: "bearer",
    header: "",
  },
  {
    id: "siliconflow",
    name: "硅基流动",
    protocol: "openai-chat",
    address: { type: "base_url", url: "https://api.siliconflow.cn/v1" },
    authentication: "bearer",
    header: "",
  },
  {
    id: "ollama",
    name: "Ollama",
    protocol: "ollama",
    address: { type: "base_url", url: "http://127.0.0.1:11434/api" },
    authentication: "none",
    header: "",
  },
  {
    id: "lmstudio",
    name: "LM Studio",
    protocol: "openai-chat",
    address: { type: "base_url", url: "http://127.0.0.1:1234/v1" },
    authentication: "none",
    header: "",
  },
  {
    id: "custom",
    name: "自定义 / API 网关",
    protocol: "openai-chat",
    address: { type: "base_url", url: "" },
    authentication: "bearer",
    header: "",
  },
];
