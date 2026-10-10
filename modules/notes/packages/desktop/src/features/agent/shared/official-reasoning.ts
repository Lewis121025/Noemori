import type { Protocol } from "./api";

/** 官方模型的命名档位与已明确公布的初始值；未公布初始值时不自行选择。 */
type ReasoningDefinition = {
  models: readonly string[];
  efforts: readonly string[];
  defaultEffort?: string;
};

// 官方模型页逐型号定义，不能把 API 的完整枚举套给每个模型。
// https://developers.openai.com/api/docs/models
const openai: readonly ReasoningDefinition[] = [
  { models: ["gpt-6-astra"], efforts: ["low", "medium", "high", "xhigh", "max"] },
  {
    models: ["gpt-6.1-sol"],
    efforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "medium",
  },
  {
    models: ["gpt-6-sol", "gpt-6-luna", "gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
    efforts: ["none", "low", "medium", "high", "xhigh", "max"],
    defaultEffort: "medium",
  },
  {
    models: ["gpt-5.5"],
    efforts: ["none", "low", "medium", "high", "xhigh"],
    defaultEffort: "medium",
  },
  {
    models: ["gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.2"],
    efforts: ["none", "low", "medium", "high", "xhigh"],
    defaultEffort: "none",
  },
  { models: ["gpt-5.1"], efforts: ["none", "low", "medium", "high"], defaultEffort: "none" },
  {
    models: ["gpt-5", "gpt-5-mini", "gpt-5-nano"],
    efforts: ["minimal", "low", "medium", "high"],
    defaultEffort: "medium",
  },
  {
    models: ["gpt-5.2-pro", "gpt-5.4-pro"],
    efforts: ["medium", "high", "xhigh"],
    defaultEffort: "medium",
  },
  { models: ["gpt-5.5-pro"], efforts: ["medium", "high", "xhigh"], defaultEffort: "high" },
  { models: ["gpt-5-pro"], efforts: ["high"], defaultEffort: "high" },
  {
    models: ["gpt-5.2-codex", "gpt-5.3-codex", "gpt-5.1-codex-max"],
    efforts: ["low", "medium", "high", "xhigh"],
    defaultEffort: "medium",
  },
  {
    models: [
      "gpt-5-codex",
      "gpt-5.1-codex",
      "gpt-5.1-codex-mini",
      "o1",
      "o3",
      "o3-mini",
      "o4-mini",
      "gpt-oss-20b",
      "gpt-oss-120b",
    ],
    efforts: ["low", "medium", "high"],
    defaultEffort: "medium",
  },
];

// effort 是输出强度，不能额外插入 thinking 开关或 OpenAI 的 none/minimal。
// https://platform.claude.com/docs/en/build-with-claude/effort
const anthropic: readonly ReasoningDefinition[] = [
  { models: ["claude-opus-4-5"], efforts: ["low", "medium", "high"], defaultEffort: "high" },
  {
    models: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-mythos-preview"],
    efforts: ["low", "medium", "high", "max"],
    defaultEffort: "high",
  },
  {
    models: [
      "claude-opus-4-7",
      "claude-opus-4-8",
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-sonnet-5-5",
      "claude-fable-5",
      "claude-fable-5-1",
      "claude-mythos-5",
      "claude-mythos-5-1",
    ],
    efforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "high",
  },
  {
    models: ["claude-opus-5-5", "claude-haiku-5-5"],
    efforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "medium",
  },
];

// 2.5 只有 token budget，不能伪装成 3.x 的命名档位。
// https://ai.google.dev/gemini-api/docs/generate-content/thinking
const gemini: readonly ReasoningDefinition[] = [
  { models: ["gemini-3.1-pro"], efforts: ["low", "medium", "high"], defaultEffort: "high" },
  {
    models: ["gemini-3-flash", "gemini-robotics-er-2"],
    efforts: ["minimal", "low", "medium", "high"],
    defaultEffort: "high",
  },
  {
    models: ["gemini-3.1-flash-lite", "gemini-3.5-flash-lite"],
    efforts: ["minimal", "low", "medium", "high"],
    defaultEffort: "minimal",
  },
  {
    models: ["gemini-3.1-flash-lite-image", "gemini-3.1-flash-image"],
    efforts: ["minimal", "high"],
    defaultEffort: "minimal",
  },
  {
    models: ["gemini-3.6-flash"],
    efforts: ["minimal", "low", "medium", "high"],
    defaultEffort: "medium",
  },
  { models: ["gemini-3.8-flash"], efforts: ["low", "medium", "high"], defaultEffort: "medium" },
];

const ollama: readonly ReasoningDefinition[] = [
  // 本地自定义模型优先使用 /api/show 报告的 values 与 default。
  // https://docs.ollama.com/capabilities/thinking
  {
    models: ["gpt-oss", "gpt-oss-20b", "gpt-oss-120b"],
    efforts: ["low", "medium", "high"],
    defaultEffort: "medium",
  },
];

const nova: readonly ReasoningDefinition[] = [
  // disabled 是独立开关，不是 maxReasoningEffort 的档位。
  // https://docs.aws.amazon.com/nova/latest/nova2-userguide/using-converse-api.html
  { models: ["amazon.nova-2-lite"], efforts: ["low", "medium", "high"] },
];

/**
 * @param modelId 请求使用的完整模型标识，包括官方快照、路由命名空间或云资源路径。
 * @param protocol 决定官方参数契约的实际协议。
 * @returns 精确匹配的官方定义；未知型号或不同协议不推断能力，不抛出异常。
 */
export function officialReasoning(
  modelId?: string,
  protocol?: Protocol,
): Omit<ReasoningDefinition, "models"> | undefined {
  if (!modelId || !protocol) return undefined;
  const identity = modelId
    .replace(/^.*\//u, "")
    .replace(/^(?:us\.|eu\.|jp\.|apac\.|global\.)/u, "")
    .replace(/^anthropic\./u, "")
    .replace(/-v1(?::0)?$/u, "")
    .replace(/(?:-\d{4}-\d{2}-\d{2}|-\d{8}|@\d{8}|-latest)$/u, "")
    .replace(/(claude-[a-z]+-\d)\.(\d)/u, "$1-$2");
  const id = identity.startsWith("gemini-")
    ? identity.replace(/-preview(?:-\d{2}-\d{2})?$/u, "")
    : identity;
  if (protocol === "ollama")
    return ollama.find((entry) => entry.models.includes(id.replace(/:.*$/u, "")));
  const definitions =
    protocol === "openai-chat" || protocol === "openai-responses"
      ? [...openai, ...anthropic, ...gemini]
      : protocol === "anthropic" || protocol === "vertex-anthropic"
        ? anthropic
        : protocol === "gemini"
          ? gemini
          : [...anthropic, ...nova, ...openai];
  return definitions.find((entry) => entry.models.includes(id));
}
