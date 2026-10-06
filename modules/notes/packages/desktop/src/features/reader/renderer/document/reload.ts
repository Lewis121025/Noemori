/**
 * 监视回声：自己写盘后不要把当前编辑器重挂。
 */

/**
 * 比较磁盘快照和编辑基准；null 表示文件缺失，与空文件不同。
 * @param left 第一份快照。
 * @param right 第二份快照。
 * @returns 字节或缺失状态是否完全一致。
 */
export function bytesEqual(left: Uint8Array | null, right: Uint8Array | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  if (left.length !== right.length) {
    return false;
  }
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) {
      return false;
    }
  }
  return true;
}
