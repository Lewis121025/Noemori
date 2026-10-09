/** 固定窗口协议的对象边界；数组、null 和非对象均被拒绝。 */
export function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Agent 协议需要对象");
  return value;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** 读取已声明的字符串，缺失字段不会默认为空值。 */
export function text(value: Record<string, unknown>, key: string): string {
  const result = value[key];
  if (typeof result !== "string") throw new Error(`Agent 字段 ${key} 需要字符串`);
  return result;
}
/** 布尔字段不接受字符串或数字代替。 */
export function boolean(value: Record<string, unknown>, key: string): boolean {
  const result = value[key];
  if (typeof result !== "boolean") throw new Error(`Agent 字段 ${key} 需要布尔值`);
  return result;
}
/** 非负整数保持 JS 安全整数边界。 */
export function integer(value: Record<string, unknown>, key: string): number {
  const result = value[key];
  if (typeof result !== "number" || !Number.isSafeInteger(result) || result < 0)
    throw new Error(`Agent 字段 ${key} 需要非负安全整数`);
  return result;
}
/** 读取显式可空字符串；缺失字段仍拒绝。 */
export function nullableText(value: Record<string, unknown>, key: string): string | null {
  return value[key] === null ? null : text(value, key);
}
/** 协议数组不接受对象或缺失值代替。 */
export function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Agent 协议需要数组");
  return value;
}
