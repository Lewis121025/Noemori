/**
 * 失败后的资源清理不能覆盖原始故障，调用方需要知道操作失败与资源遗留的完整原因。
 * @param cause 操作的原始异常，不改写其类型或内容。
 * @param cleanup 释放本次操作拥有的资源；成功和失败均等待其实际完成。
 * @param message 操作和清理同时失败时的固定阶段说明。
 * @returns 始终拒绝，不把清理成功当作原操作成功。
 * @throws 清理成功时重抛原异常；清理失败时抛出同时包含两处原因的 AggregateError。
 */
export async function rethrowAfterCleanup(
  cause: unknown,
  cleanup: () => Promise<void>,
  message: string,
): Promise<never> {
  try {
    await cleanup();
  } catch (failure) {
    throw new AggregateError([cause, failure], message);
  }
  throw cause;
}
