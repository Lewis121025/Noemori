import { isArrayBuffer } from "node:util/types";
import { isMarkedAsUntransferable } from "node:worker_threads";

/**
 * 取得线程消息可独占的字节；共享池和切片不能转移整个底层缓冲区。
 * @param bytes 本次消息的有效内容；可转移的独占输入会在发送后失去所有权。
 * @returns 字节和对应转移列表；复制仅覆盖有效视图，避免泄露或分离相邻内容。
 * @throws 无法为共享或不可转移输入分配副本时传播分配错误，任务应停止。
 */
export function exportByteTransfer(bytes: Uint8Array): {
  bytes: Uint8Array;
  transfer: ArrayBuffer[];
} {
  if (
    isArrayBuffer(bytes.buffer) &&
    !isMarkedAsUntransferable(bytes.buffer) &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
  )
    return { bytes, transfer: [bytes.buffer] };
  const owned = new Uint8Array(bytes);
  return { bytes: owned, transfer: [owned.buffer] };
}
