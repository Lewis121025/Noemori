/** 悬停表面在容器内容坐标中的矩形；装饰层不参与控件布局。 */
export type PointerBounds = { x: number; y: number; width: number; height: number };
/** 光标位置使用像素，速度使用像素/毫秒。 */
export type PointerPoint = { x: number; y: number };
/** 同组控件形成一条连续路径；几何只在布局改变时重新建立。 */
export type PointerSurface = { axis: "x" | "y"; bounds: readonly PointerBounds[] };
/** 光斑的有界方向形变；dx/dy 为每秒形变速度，settled 表示可停止绘制。 */
export type PointerFlow = { x: number; y: number; dx: number; dy: number; settled: boolean };
/** 主体围绕光标变形，尾部表达移动方向；所有参数仅作用于装饰层。 */
export type PointerContour = {
  body: readonly [number, number, number, number];
  wake: { x: number; y: number; scale: number; opacity: number };
  stretch: number;
};

const center = (bounds: PointerBounds, axis: "x" | "y") =>
  bounds[axis] + bounds[axis === "x" ? "width" : "height"] / 2;
const clamp = (value: number, lower: number, upper: number) =>
  Math.max(lower, Math.min(upper, value));

/**
 * 形变保留方向和动量；停止时轻微回弹，光标位置不参与弹簧计算。
 * @param state 当前形变及速度；形变须在 ±1.5 内，速度须在 ±128 内。
 * @param velocity 投影到 32px 装饰平面的输入速度，单位为像素/毫秒。
 * @param elapsedMs 距上次绘制经过的非负毫秒数。
 * @returns 新的形变状态；达到视觉静止后 settled 为 true。
 * @throws 非有限值、越界状态或负时间抛出 RangeError。
 */
export function samplePointerFlow(
  state: PointerFlow,
  velocity: PointerPoint,
  elapsedMs: number,
): PointerFlow {
  if (
    ![state.x, state.y, state.dx, state.dy, velocity.x, velocity.y, elapsedMs].every(
      Number.isFinite,
    ) ||
    Math.abs(state.x) > 1.5 ||
    Math.abs(state.y) > 1.5 ||
    Math.abs(state.dx) > 128 ||
    Math.abs(state.dy) > 128 ||
    elapsedMs < 0
  )
    throw new RangeError("光斑需要有界形变、有限速度与非负时间");
  const time = elapsedMs / 1000;
  const damping = 36 * 0.62;
  const frequency = 36 * Math.sqrt(1 - 0.62 ** 2);
  const decay = Math.exp(-damping * time);
  const cosine = Math.cos(frequency * time),
    sine = Math.sin(frequency * time);
  const sample = (position: number, speed: number, input: number) => {
    const target = Math.tanh(input / 1.2);
    const offset = position - target;
    const impulse = (speed + damping * offset) / frequency;
    const value = target + decay * (offset * cosine + impulse * sine);
    const rate = decay * (speed * cosine - (damping * impulse + frequency * offset) * sine);
    const settled = Math.abs(value - target) < 0.001 && Math.abs(rate) < 0.04;
    // 急转的动量只改变轮廓，限幅避免反复往返累积成夸张的尾部。
    const bounded = clamp(value, -1.5, 1.5);
    return {
      value: settled ? target : bounded,
      rate: settled || bounded !== value ? 0 : clamp(rate, -128, 128),
      settled,
    };
  };
  const x = sample(state.x, state.dx, velocity.x),
    y = sample(state.y, state.dy, velocity.y);
  return { x: x.value, y: y.value, dx: x.rate, dy: y.rate, settled: x.settled && y.settled };
}

/**
 * 把方向形变变成饱满主体与柔软尾部，零形变回到安静的圆润光斑。
 * @param flow 已随时间衔接的有界方向形变。
 * @returns 主体矩阵、尾部位姿与外层伸展；主体中心始终位于光标锚点。
 * @throws 非有限或越界方向形变抛出 RangeError。
 */
export function pointerContour(flow: PointerFlow): PointerContour {
  if (![flow.x, flow.y].every(Number.isFinite) || Math.abs(flow.x) > 1.5 || Math.abs(flow.y) > 1.5)
    throw new RangeError("光斑轮廓需要有界方向形变");
  const distance = Math.hypot(flow.x, flow.y);
  const energy = Math.min(1, distance);
  const x = distance ? flow.x / distance : 0,
    y = distance ? flow.y / distance : 0;
  const shear = 0.24 * energy * x * y;
  return {
    body: [
      0.9 + energy * (0.1 * x * x - 0.14 * y * y),
      shear,
      shear,
      0.9 + energy * (0.1 * y * y - 0.14 * x * x),
    ],
    wake: {
      x: -5.2 * energy * x,
      y: -5.2 * energy * y,
      scale: 0.54 + energy * 0.13,
      opacity: energy * 0.55,
    },
    stretch: energy * 0.12,
  };
}

/**
 * 从实际控件建立横向或纵向的连续悬停路径，不修改输入矩形。
 * @param bounds 已过滤隐藏和禁用控件的有限、非空矩形。
 * @returns 按主轴排序的路径；没有可交互项时返回 null。
 * @throws 非有限坐标或非正尺寸抛出 RangeError。
 */
export function createPointerSurface(bounds: readonly PointerBounds[]): PointerSurface | null {
  if (!bounds.length) return null;
  if (
    bounds.some(
      (value) =>
        ![value.x, value.y, value.width, value.height].every(Number.isFinite) ||
        value.width <= 0 ||
        value.height <= 0,
    )
  )
    throw new RangeError("光标路径需要有限坐标与非空矩形");
  const spread = (axis: "x" | "y") => {
    const values = bounds.map((value) => center(value, axis));
    return Math.max(...values) - Math.min(...values);
  };
  const axis = spread("x") >= spread("y") ? "x" : "y";
  return {
    axis,
    bounds: [...bounds].sort((left, right) => center(left, axis) - center(right, axis)),
  };
}

/**
 * 光标直接决定光照中心；相邻控件之间柔和变形，伸展不改变中心。
 * @param surface 当前容器的实际控件路径。
 * @param point 当前帧的光标内容坐标；不依赖上一段动画的位置或速度。
 * @param stretch 已随时间衔接的伸展比例；零值表示自然形状。
 * @returns 与光标同帧响应的装饰矩形；移入空白区域时返回 null。
 * @throws 非有限光标坐标或越界伸展比例抛出 RangeError。
 */
export function pointerSurface(
  surface: PointerSurface,
  point: PointerPoint,
  stretch: number,
): PointerBounds | null {
  if (![point.x, point.y, stretch].every(Number.isFinite) || stretch < 0 || stretch > 0.12)
    throw new RangeError("光标反馈需要有限位置与有界形变");
  const { axis, bounds } = surface;
  const cross = axis === "x" ? "y" : "x";
  const size = axis === "x" ? "width" : "height";
  const first = bounds[0]!,
    last = bounds.at(-1)!;
  if (point[axis] < first[axis] - 6 || point[axis] > last[axis] + last[size] + 6) return null;
  // 首尾控件内部也直接跟随，只有移入路径外缘的空白时才限制光照中心。
  const coordinate = clamp(point[axis], first[axis], last[axis] + last[size]);
  const index = bounds.findIndex((value) => center(value, axis) >= coordinate);
  const right = index < 0 ? last : bounds[index]!;
  const left = index <= 0 ? right : bounds[index - 1]!;
  const distance = center(right, axis) - center(left, axis);
  const progress = distance === 0 ? 0 : clamp((coordinate - center(left, axis)) / distance, 0, 1);
  // 在每个控件中心以零斜率交接尺寸，消除宽窄变化的尖锐转折。
  const blend = progress * progress * (3 - 2 * progress);
  const mix = (a: number, b: number) => a + (b - a) * blend;
  const crossCenter = mix(center(left, cross), center(right, cross));
  const contact = crossCenter + clamp((point[cross] - crossCenter) * 0.08, -2, 2);
  const width = mix(left.width, right.width) * (axis === "x" ? 1 + stretch : 1 - stretch * 0.45);
  const height = mix(left.height, right.height) * (axis === "y" ? 1 + stretch : 1 - stretch * 0.45);
  return {
    x: (axis === "x" ? coordinate : contact) - width / 2,
    y: (axis === "y" ? coordinate : contact) - height / 2,
    width,
    height,
  };
}
