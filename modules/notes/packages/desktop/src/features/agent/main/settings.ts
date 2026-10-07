import { safeStorage } from "electron";
import type { Authentication, ModelSettings, PublicModelSettings } from "../shared/api";
import { parseAuthentication, parseModelSettings, record, text } from "../shared/parse";
import { parsePrivateJson } from "./private-json";

/** 旧版单模型磁盘记录，仅在迁移时读取；新会话不保存连接或认证。 */
export type ProtectedModel = {
  settings: Omit<ModelSettings, "authentication">;
  authentication: string | null;
};

/**
 * @param authentication 已通过认证契约验证的私有材料。
 * @returns 可落盘密文；无认证返回 null，原文不离开主进程。
 * @throws 系统加密不可用或加密失败时拒绝，不退回明文存储。
 */
export function encryptAuthentication(authentication: Authentication): string | null {
  if (authentication.type !== "none" && !safeStorage.isEncryptionAvailable())
    throw new Error("系统安全存储不可用，无法保存模型认证");
  return authentication.type === "none"
    ? null
    : safeStorage.encryptString(JSON.stringify(authentication)).toString("base64");
}

/**
 * 旧版迁移先验证非认证字段，认证仍保持系统密文。
 * @param value 旧版磁盘模型记录。
 * @returns 已校验参数与密文；不触发系统解密。
 * @throws 配置或密文字段结构无效时拒绝。
 */
export function parseProtectedModel(value: unknown): ProtectedModel {
  const stored = record(value);
  const parsed = parseModelSettings({
    ...record(stored["settings"]),
    authentication: { type: "none" },
  });
  const settings = {
    protocol: parsed.protocol,
    model: parsed.model,
    endpoint: parsed.endpoint,
    tools: parsed.tools,
    streaming: parsed.streaming,
    vision: parsed.vision,
    audio: parsed.audio,
    video: parsed.video,
  };
  return {
    settings,
    authentication: stored["authentication"] === null ? null : text(stored, "authentication"),
  };
}

/**
 * 认证只交给主进程请求边界，异常只报告故障阶段，不能包含解密原文。
 * @param encrypted 系统密文；null 明确表示无认证。
 * @returns 已校验的认证，不降级为其他类型。
 * @throws 系统解密失败、JSON 或认证契约无效时拒绝。
 */
export function decryptAuthentication(encrypted: string | null): Authentication {
  if (encrypted === null) return { type: "none" };
  let content: string;
  try {
    content = safeStorage.decryptString(Buffer.from(encrypted, "base64"));
  } catch {
    throw new Error("系统安全存储无法解密模型认证");
  }
  return parseAuthentication(parsePrivateJson(content, "模型认证"));
}

/**
 * @param authentication 已验证的主进程认证。
 * @returns 只包含类型、配置状态和必要提示的描述，不包含凭据，也不抛出异常。
 */
export function authenticationDescription(
  authentication: Authentication,
): PublicModelSettings["authentication"] {
  return {
    type: authentication.type,
    configured: authentication.type !== "none",
    name: authentication.type === "header" ? authentication.name : "",
    region: authentication.type === "aws" ? authentication.region : "",
  };
}
