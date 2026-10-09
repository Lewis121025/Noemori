/** 空间动效某一轴的当前位置（像素）与速度（像素/秒）。 */
export type MotionCoordinate = { position: number; velocity: number };

/**
 * 选中底色与工作区共用临界阻尼的解析解，改目标时保留速度，帧率变化不改变节奏。
 * @param current 当前轴状态。
 * @param target 当前布局或选择对应的目标坐标或尺寸。
 * @param seconds 距上一帧的非负秒数；零表示不推进。
 * @returns 新位置和速度，无副作用；角频率固定为 28/s，不产生往复振荡。
 * @throws 参数非有限数或时间为负时抛出 RangeError。
 */
export function advanceMotion(
  current: MotionCoordinate,
  target: number,
  seconds: number,
): MotionCoordinate {
  if (![current.position, current.velocity, target, seconds].every(Number.isFinite) || seconds < 0)
    throw new RangeError("空间动效需要有限坐标与非负时间");
  const frequency = 28;
  const offset = current.position - target;
  const momentum = current.velocity + frequency * offset;
  const decay = Math.exp(-frequency * seconds);
  return {
    position: target + (offset + momentum * seconds) * decay,
    velocity: (current.velocity - frequency * momentum * seconds) * decay,
  };
}
