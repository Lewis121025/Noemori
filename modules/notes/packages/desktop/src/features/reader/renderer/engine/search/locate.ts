import type { SearchLocation } from "../../../shared/api";
import type { EditorSnapshot } from "../markdown/source-session";

/**
 * 核对索引与当前编辑快照的原始字节，防止结果指向已变化的正文。
 * @param snapshot 编辑器生成的保真快照；调用方在异步校验后还必须核对编辑版本。
 * @param contentHash 索引保存的 SHA-256。
 * @param location 同一版本内的 UTF-8 范围。
 * @throws 内容已变化、范围越界或切断 UTF-8 字符时拒绝定位。
 */
export async function verifySearchSnapshot(
  snapshot: EditorSnapshot,
  contentHash: string,
  location: SearchLocation,
): Promise<void> {
  const bytes = snapshot.bytes;
  const { startByte, endByte } = location;
  const boundary = (at: number) => at === bytes.length || ((bytes[at] ?? 0) & 0xc0) !== 0x80;
  if (
    !Number.isSafeInteger(startByte) ||
    !Number.isSafeInteger(endByte) ||
    startByte < 0 ||
    endByte <= startByte ||
    endByte > bytes.length ||
    !boundary(startByte) ||
    !boundary(endByte)
  )
    throw new Error("搜索结果范围无效，请重新搜索。");
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  if (hash !== contentHash) throw new Error("笔记内容已变化，请重新搜索后定位。");
}
