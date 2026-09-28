/**
 * 死链可创建的笔记路径。
 *
 * 路径形式（含 `/`）按库根解释；裸名落在当前笔记所在目录。
 * 没有扩展名时补 `.md`，已有扩展名保持原样，这样创建结果和 wiki 解析用的是同一条键。
 * Markdown 链接按源文件目录拼接，并做百分号解码；越界、纯锚点和非法名称不创建。
 */

import type { LinkKind } from "../../../shared/api";
import { splitLinkResource } from "../../../shared/link-target";

/** 死链对应的新笔记位置；不能创建时为 `null`。 */
export type DeadLinkOffer = {
  /** 库内相对路径。 */
  path: string;
  /** 创建后继续定位的标题或块锚点。 */
  anchor: string | null;
};

/**
 * 死链笔记的初始内容：`#标题` 锚点写成首个标题，创建后锚点立即可解析，
 * 不再产出「打开即报锚点失效」的空文件。
 *
 * 块引用（`^`）不是标题、非 Markdown 目标没有标题语义，均不种内容。
 * 确认对话框的文案与工作区的创建共用本判定，避免两处口径漂移。
 *
 * @param offer 死链创建位置与锚点。
 * @returns 创建事务的初始字节；不种内容时为 `null`。
 */
export function deadLinkSeed(offer: DeadLinkOffer): Uint8Array | null {
  if (offer.anchor === null || offer.anchor.startsWith("^")) return null;
  if (!offer.path.toLowerCase().endsWith(".md")) return null;
  return new TextEncoder().encode(`# ${offer.anchor}\n\n`);
}

/**
 * 从链接原文算出可创建的路径。
 *
 * @param from 当前笔记的库内路径。
 * @param raw 链接原文，可以带 `#` 锚点。
 * @param kind wiki 或 Markdown。
 * @returns 合法的创建位置；纯锚点、越界或非法名称返回 `null`。
 */
export function deadLinkCreatePath(
  from: string,
  raw: string,
  kind: LinkKind,
): DeadLinkOffer | null {
  const { path: resource, anchor } = splitLinkResource(raw);
  if (resource === "") return null;
  const path =
    kind === "wiki" ? wikiCreatePath(from, resource) : markdownCreatePath(from, resource);
  if (path === null || !creatable(path)) return null;
  return { path, anchor };
}

function wikiCreatePath(from: string, resource: string): string | null {
  const withExtension = ensureNoteExtension(resource);
  if (withExtension.includes("/")) return normalize(withExtension.split("/"));
  return normalize([...directoryOf(from), ...withExtension.split("/")]);
}

function markdownCreatePath(from: string, resource: string): string | null {
  let decoded = resource;
  try {
    decoded = decodeURIComponent(resource);
  } catch {
    return null;
  }
  if (decoded.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(decoded)) return null;
  return normalize([...directoryOf(from), ...decoded.split("/")]);
}

function directoryOf(from: string): string[] {
  const slash = from.lastIndexOf("/");
  return slash < 0 ? [] : from.slice(0, slash).split("/");
}

function ensureNoteExtension(resource: string): string {
  const name = resource.slice(resource.lastIndexOf("/") + 1);
  if (name.startsWith(".") || name.includes(".")) return resource;
  return `${resource}.md`;
}

function normalize(parts: string[]): string | null {
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.length === 0 ? null : out.join("/");
}

/** 与内核 `validate_entry_path` 同一组拒绝条件，避免弹出必然失败的创建。 */
function creatable(path: string): boolean {
  return path.split("/").every((name) => {
    if (name === "" || name !== name.trim() || name.startsWith(".") || name.endsWith("."))
      return false;
    return ![...name].some(
      (character) => character.charCodeAt(0) < 32 || '\\:*?"<>|'.includes(character),
    );
  });
}
