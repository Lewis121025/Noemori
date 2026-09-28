/**
 * 监视回声：自己写盘后不要把当前编辑器重挂。
 */

/**
 * 是否应用磁盘上的新字节替换编辑器 `source`。
 *
 * 缓冲仍脏时不能冲掉未保存改动；字节与上次写盘相同则视为自己的回声。
 *
 * @param dirty 缓冲是否相对上次成功写盘有未保存改动。
 * @param original 打开或上次保存时的字节；尚无则为 `null`。
 * @param disk 刚从磁盘读到的字节。
 * @returns 为真时才应赋值 `source`。
 */
export function shouldReloadSource(
  dirty: boolean,
  original: Uint8Array | null,
  disk: Uint8Array,
): boolean {
  if (dirty) {
    return false;
  }
  if (original !== null && bytesEqual(original, disk)) {
    return false;
  }
  return true;
}

/** 监视读盘后是否应用到当前编辑器。 */
export type ReloadApply = {
  /** 缓冲是否相对上次成功写盘仍有未保存改动。 */
  dirty: boolean;
  /** 读盘完成后的当前路径。 */
  currentPath: string | null;
  /** 发起读盘时的路径。 */
  pathWhenStarted: string;
  /** 打开或上次保存时的字节。 */
  original: Uint8Array | null;
  /** 刚从磁盘读到的字节。 */
  disk: Uint8Array;
};

/**
 * 读盘期间路径或脏状态可能已经变了，过期结果不得写进当前编辑器。
 *
 * @param input 读盘前后的路径、脏标记与字节。
 * @returns 为真时才应赋值 `source`。
 */
export function shouldApplyReload(input: ReloadApply): boolean {
  if (input.currentPath !== input.pathWhenStarted) {
    return false;
  }
  return shouldReloadSource(input.dirty, input.original, input.disk);
}

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
