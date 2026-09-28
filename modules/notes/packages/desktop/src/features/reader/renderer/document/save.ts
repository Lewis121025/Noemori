/**
 * 保存时的字节选择：未改走 identity，已改才获取编辑快照。
 */
import type { EditorSnapshot } from "../markdown/source-session";

/**
 * 决定写回磁盘的字节。
 *
 * 未修改时必须返回打开时的原始字节，且不得调用 `snapshot`，
 * 这样反复保存不会把未改动的 Markdown 规范化。
 *
 * @param dirty 当前缓冲是否相对打开时有过编辑。
 * @param original 打开（或上次保存）时的原始字节。
 * @param snapshot 已修改时获取编辑器保真的内容快照。
 * @returns 应交给 `file.write` 的字节。
 */
export function bytesForSave(
  dirty: boolean,
  original: Uint8Array,
  snapshot: () => EditorSnapshot,
): Uint8Array {
  if (!dirty) {
    return original;
  }
  return snapshot().bytes;
}

/** 写盘成功后的缓冲状态。 */
export type SaveCommit = {
  /** 已落到磁盘的字节，作为下次 identity 基准。 */
  originalBytes: Uint8Array;
  /** 序列化之后又有编辑则为 true。 */
  dirty: boolean;
};

/**
 * 写盘成功后更新缓冲状态。
 *
 * 磁盘基准总是刚写入的字节；只有序列化代次仍是最新时才标干净。
 *
 * @param written 本次实际写入的字节。
 * @param serializedGen 调用序列化时的编辑代次。
 * @param currentGen 写盘完成后的编辑代次。
 * @returns 应写回外壳的 `originalBytes` / `dirty`。
 */
export function commitSuccessfulWrite(
  written: Uint8Array,
  serializedGen: number,
  currentGen: number,
): SaveCommit {
  return {
    originalBytes: written,
    dirty: serializedGen !== currentGen,
  };
}
