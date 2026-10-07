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
