import { realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { boundedFile } from "./attachments";
import { MAX_ATTACHMENT_BYTES } from "../shared/attachments";
import { contentName, remoteContentUrl, type ConversationContent } from "../shared/content";
import { previewContentBytes } from "./content-files";

async function remoteBytes(url: string): Promise<Buffer> {
  const response = await fetch(url, {
    credentials: "omit",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`内容读取失败（${response.status}）`);
  if (Number(response.headers.get("content-length")) > MAX_ATTACHMENT_BYTES) {
    await response.body?.cancel();
    throw new Error("预览文件不能超过 25 MiB");
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_ATTACHMENT_BYTES) throw new Error("预览文件不能超过 25 MiB");
      chunks.push(chunk.value);
    }
  } catch (cause) {
    try {
      await reader.cancel();
    } catch (cleanup) {
      throw new AggregateError([cause, cleanup], "内容读取失败且请求未能完整关闭");
    }
    throw cause;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length);
}

/**
 * @param workspace 该会话实际运行目录；独立对话同样具有私有运行目录。
 * @param reference Markdown 引用，外部内容仅在用户明确请求预览时传入。
 * @returns 完整原始快照与渲染投影，预览和保存共用同一次读取。
 * @throws 协议、越界、符号链接越界、目录、超限、读取变化或网络失败时拒绝。
 */
export async function readConversationContent(
  workspace: string,
  reference: string,
): Promise<ConversationContent> {
  if (
    !reference ||
    reference.length > 8192 ||
    [...reference].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new Error("内容地址无效");
  const remote = remoteContentUrl(reference);
  let bytes: Buffer, name: string;
  if (remote) {
    bytes = await remoteBytes(remote);
    name = contentName(remote);
  } else {
    const root = await realpath(workspace);
    const url = new URL(reference, pathToFileURL(root + sep));
    if (url.protocol !== "file:") throw new Error("不支持这个内容地址");
    const path = await realpath(fileURLToPath(url));
    const rel = relative(root, path);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      throw new Error("文件不在当前对话工作区中");
    bytes = await boundedFile(path);
    name = basename(path);
  }
  return { name, bytes: new Uint8Array(bytes), preview: previewContentBytes(name, bytes) };
}
