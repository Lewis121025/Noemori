import { open, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { rethrowAfterCleanup } from "./cleanup";

/**
 * 私有 JSON 的语法异常只报告阶段，防止解析器把认证或供应商签名片段写进界面错误。
 * @param content 主进程持有的完整 JSON 文本。
 * @param context 固定故障阶段，不接收用户内容或密钥。
 * @returns 待领域契约继续验证的数据。
 * @throws 语法无效时抛出不含原文的格式错误。
 */
export function parsePrivateJson(
  content: string,
  context: "模型认证" | "供应商配置" | "对话记录" | "对话检查点",
): unknown {
  try {
    return JSON.parse(content);
  } catch {
    throw new Error(`${context}格式无效`);
  }
}

/**
 * 同目录临时文件写完并关闭后再替换，独占创建成功前不取得路径的清理权限。
 * @param destination 调用方拥有的目标文件；父目录必须已经存在。
 * @param content 已序列化的完整 JSON 快照，领域校验由调用方在提交前完成。
 * @returns 原子替换成功后兑现；替换前的失败保留旧文件。
 * @throws 创建、写入、关闭或替换失败时拒绝；回滚也失败时同时保留两处原因。
 */
export async function writePrivateJson(destination: string, content: string): Promise<void> {
  const temporary = `${destination}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    try {
      await handle.writeFile(content);
    } catch (cause) {
      await rethrowAfterCleanup(cause, () => handle.close(), "JSON 写入失败且句柄未能完整关闭");
    }
    await handle.close();
    await rename(temporary, destination);
  } catch (cause) {
    return rethrowAfterCleanup(
      cause,
      () => rm(temporary, { force: true }),
      "JSON 文件未提交且临时副本未能完整清理",
    );
  }
}
