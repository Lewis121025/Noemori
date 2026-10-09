import { boolean, record, text } from "./parse";

/** 待发送追问的稳定身份；sending 是已落盘的发送意图，重启后不能据此自动重发。 */
export type QueuedMessage = { id: string; text: string; state: "queued" | "sending" };
/** 队列归属单条对话；停止、失败与重启暂停队列，错误与模型生成状态独立。 */
export type ConversationQueue = {
  messages: QueuedMessage[];
  paused: boolean;
  error: string | null;
};

/** 返回独立的空队列；新对话和旧版本迁移共用，不读写状态，不抛出异常。 */
export function newConversationQueue(): ConversationQueue {
  return { messages: [], paused: false, error: null };
}

/**
 * @param value 用户提交的原始文字。
 * @returns 原文，不改变空格或换行。
 * @throws 非文本、空白或 UTF-8 超过原生模型输入的 128 KiB 上限时拒绝。
 */
export function parseQueueText(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    new TextEncoder().encode(value).length > 128 * 1024
  )
    throw new Error("追问或补充指令必须非空且不超过 128 KiB");
  return value;
}

/**
 * @param value 未信任的磁盘队列。
 * @returns 有界且身份唯一的队列，保留未确认的发送状态。
 * @throws 队列、身份、文字、状态或错误类型无效时拒绝，不丢弃待发送内容。
 */
export function parseConversationQueue(value: unknown): ConversationQueue {
  const input = record(value);
  const raw = input["messages"];
  if (!Array.isArray(raw) || raw.length > 16) throw new Error("追问队列无效或超过 16 条");
  const messages = raw.map((value): QueuedMessage => {
    const item = record(value),
      id = text(item, "id"),
      state = item["state"];
    if (!id || id.length > 128 || (state !== "queued" && state !== "sending"))
      throw new Error("追问记录无效");
    return { id, text: parseQueueText(item["text"]), state };
  });
  if (new Set(messages.map((message) => message.id)).size !== messages.length)
    throw new Error("追问标识重复");
  const error = input["error"] === null ? null : text(input, "error");
  return { messages, paused: boolean(input, "paused"), error };
}
