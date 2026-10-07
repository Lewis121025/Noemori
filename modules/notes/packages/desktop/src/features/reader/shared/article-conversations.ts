const identifier = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const prefix = "noemori://conversation/";

/** 读取应用内对话 URI；无效或外部链接返回 null，不抛错也不触发导航。 */
export function articleConversationId(href: string): string | null {
  const id = href.startsWith(prefix) ? href.slice(prefix.length) : "";
  return identifier.test(id) ? id : null;
}

/** 生成稳定的正文链接；无效身份抛错，禁止将路径或任意 URL 塞入标记。 */
export function articleConversationHref(id: string): string {
  if (!identifier.test(id)) throw new Error("对话标记无效");
  return `${prefix}${id}`;
}
