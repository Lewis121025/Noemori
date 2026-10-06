import { BOARD_COORDINATE_LIMIT, type InkPoint } from "./model";
import { segmentDistance, type FitPoint } from "./fitting-math";

const MIN_CUTOFF_HZ = 3;
const NORMAL_CUTOFF_HZ = 2.5;
const SPEED_CUTOFF = 0.04;
const DERIVATIVE_CUTOFF_HZ = 1;
const HEADING_CUTOFF_HZ = 0.5;
const MAX_LAG_CSS_PX = 8;

/** 原始位置与真实时刻；缺失时间不得通过估计频率补造。 */
type Observation = { point: InkPoint; time: number | undefined };
/** 局部屏幕坐标中的速度与低通状态，时间单位为毫秒。 */
type FilterState = {
  raw: FitPoint;
  value: FitPoint;
  velocity: FitPoint;
  heading: FitPoint;
  time: number | undefined;
};

function validateTime(time: number | undefined): void {
  if (time !== undefined && (!Number.isFinite(time) || time < 0))
    throw new RangeError("笔迹采样时间必须为非负有限数");
}

function weight(cutoff: number, seconds: number): number {
  return 1 / (1 + 1 / (2 * Math.PI * cutoff * seconds));
}

function filtered(
  raw: FitPoint,
  time: number | undefined,
  previous: FilterState,
  lag: number,
): FilterState {
  const seconds =
    time !== undefined && previous.time !== undefined ? (time - previous.time) / 1000 : 0;
  // 同时刻或时间未知的观测没有可验证的速度；长时间缺采样也不能凭旧速度补出轨迹。
  if (seconds < 0.0001 || seconds > 0.1)
    return { raw, value: raw, velocity: { x: 0, y: 0 }, heading: { x: 0, y: 0 }, time };
  const derivative = weight(DERIVATIVE_CUTOFF_HZ, seconds);
  const velocity = {
    x:
      previous.velocity.x + derivative * ((raw.x - previous.raw.x) / seconds - previous.velocity.x),
    y:
      previous.velocity.y + derivative * ((raw.y - previous.raw.y) / seconds - previous.velocity.y),
  };
  const speed = Math.hypot(velocity.x, velocity.y);
  const headingWeight = weight(HEADING_CUTOFF_HZ, seconds);
  // 方向比速度使用更低的截止频率，避免横向手抖把行进轴来回扭向噪声。
  const heading = {
    x:
      previous.heading.x +
      headingWeight * ((raw.x - previous.raw.x) / seconds - previous.heading.x),
    y:
      previous.heading.y +
      headingWeight * ((raw.y - previous.raw.y) / seconds - previous.heading.y),
  };
  const headingLength = Math.hypot(heading.x, heading.y);
  const along = weight(MIN_CUTOFF_HZ + SPEED_CUTOFF * speed, seconds);
  const across = weight(NORMAL_CUTOFF_HZ, seconds);
  const dx = raw.x - previous.value.x,
    dy = raw.y - previous.value.y;
  const ux = headingLength > 1e-8 ? heading.x / headingLength : 0,
    uy = headingLength > 1e-8 ? heading.y / headingLength : 0;
  const advance = dx * ux + dy * uy;
  // 沿稳定行进方向减少跟笔延迟；横向不能因写画速度快而失去抗抖，方向计算不依赖坐标轴。
  let x = previous.value.x + across * dx + (along - across) * advance * ux,
    y = previous.value.y + across * dy + (along - across) * advance * uy;
  const distance = Math.hypot(x - raw.x, y - raw.y);
  if (distance > lag) {
    x = raw.x + ((x - raw.x) * lag) / distance;
    y = raw.y + ((y - raw.y) * lag) / distance;
  }
  return { raw, value: { x, y }, velocity, heading, time };
}

/**
 * 单笔 One Euro 自适应滤波；屏幕局部坐标控制抖动与延迟，原始观测独立保留。
 * 笔尖末点始终使用真实坐标，已经画出的主体使用滤波结果；抬笔不会额外改变几何。
 */
export class InkSmoother {
  private readonly observations: Observation[];
  private readonly trace: InkPoint[];
  private readonly displayed: InkPoint[];
  private readonly corners = new Set<number>();
  private state: FilterState;
  private extent = 0;

  /**
   * @param origin 已校验的世界坐标与压力，原始坐标和压力不修改。
   * @param scale 正的有限相机比例，一笔内固定，算法以 CSS 像素工作。
   * @param time 真实采样时间，单位毫秒；缺失时不猜测频率，保留真实采样。
   * @throws 时间或缩放无效时抛 RangeError。
   */
  constructor(
    private readonly origin: InkPoint,
    private readonly scale: number,
    time?: number,
  ) {
    validateTime(time);
    if (!(scale > 0) || !Number.isFinite(scale)) throw new RangeError("笔迹平滑缩放无效");
    this.observations = [{ point: origin, time }];
    this.trace = [origin];
    this.displayed = [origin];
    this.state = {
      raw: { x: 0, y: 0 },
      value: { x: 0, y: 0 },
      velocity: { x: 0, y: 0 },
      heading: { x: 0, y: 0 },
      time,
    };
  }

  /** 用于实时绘制并保存的轨迹；末点跟随真实笔尖，压力始终来自对应观测。 */
  get points(): readonly InkPoint[] {
    return this.displayed;
  }

  /** 用于判断真实运动和停笔的稳定轨迹，末点不混入显示笔尖的临时连接。 */
  get motion(): readonly InkPoint[] {
    return this.trace;
  }

  /**
   * 校验追加时间，供输入会话在修改原始轨迹之前守住事务边界。
   * @param time 真实毫秒采样时间；同时刻允许，倒退不得排序或改写成伪造的时刻。
   * @throws 时间非法或倒退时抛 RangeError，内部状态不修改。
   */
  checkTime(time?: number): void {
    validateTime(time);
    const previous = this.observations.at(-1)!.time;
    if (time !== undefined && previous !== undefined && time < previous)
      throw new RangeError("笔迹采样时间不能倒退");
  }

  /**
   * 追加已校验的真实采样，以平滑速度调整截止频率，并保护有明确双侧直边的转角。
   * @param point 世界坐标及原始压力；不补点、不预测笔尖之后的轨迹。
   * @param time 非负真实毫秒时刻；缺失或同时刻观测保留几何，不能制造滤波频率。
   * @param terminal 是否为真实抬笔采样；仅压力变化时保留当前笔尖连接。
   * @throws 时间非法或倒退时抛 RangeError，内部状态不修改。
   */
  push(point: InkPoint, time?: number, terminal = false): void {
    this.checkTime(time);
    const previous = this.observations.at(-1)!.point;
    const raw = {
      x: (point.x - this.origin.x) * this.scale,
      y: (point.y - this.origin.y) * this.scale,
    };
    this.extent = Math.max(this.extent, Math.hypot(raw.x, raw.y));
    const lag = this.extent <= 8 ? 0 : Math.min(MAX_LAG_CSS_PX, this.extent * 0.06);
    this.state = filtered(raw, time, this.state, lag);
    const x = this.origin.x + this.state.value.x / this.scale,
      y = this.origin.y + this.state.value.y / this.scale;
    // 方向滤波的两个轴权重不同；在世界坐标边界附近也必须产出可保存的几何。
    const value = {
      x: Math.max(-BOARD_COORDINATE_LIMIT, Math.min(BOARD_COORDINATE_LIMIT, x)),
      y: Math.max(-BOARD_COORDINATE_LIMIT, Math.min(BOARD_COORDINATE_LIMIT, y)),
      pressure: point.pressure,
    };
    if (value.x !== x) this.state.value.x = (value.x - this.origin.x) * this.scale;
    if (value.y !== y) this.state.value.y = (value.y - this.origin.y) * this.scale;
    if (!(terminal && point.x === previous.x && point.y === previous.y))
      this.displayed[this.displayed.length - 1] = this.trace.at(-1)!;
    this.observations.push({ point, time });
    this.trace.push(value);
    this.displayed.push(point);
    this.protectSmoothMotion();
    this.protectCorner();
  }

  private protectSmoothMotion(): void {
    const end = this.observations.at(-1)!;
    if (end.time === undefined) return;
    let start = this.observations.length - 1;
    while (start > Math.max(0, this.observations.length - 32)) {
      const earlier = this.observations[start - 1]!.time;
      if (earlier === undefined || end.time - earlier > 100) break;
      start--;
    }
    if (end.time - this.observations[start]!.time! < 60 || this.observations.length - start < 5)
      return;
    let minimum = Infinity,
      maximum = -Infinity;
    for (let i = start + 2; i < this.observations.length; i++) {
      const a = this.observations[i - 2]!.point,
        b = this.observations[i - 1]!.point,
        c = this.observations[i]!.point;
      const ax = (b.x - a.x) * this.scale,
        ay = (b.y - a.y) * this.scale,
        bx = (c.x - b.x) * this.scale,
        by = (c.y - b.y) * this.scale;
      const first = Math.hypot(ax, ay),
        second = Math.hypot(bx, by),
        chord = Math.hypot(ax + bx, ay + by);
      if (Math.min(first, second, chord) < 0.1 || ax * bx + ay * by <= 0) return;
      const curvature = (2 * (ax * by - ay * bx)) / (first * second * chord);
      minimum = Math.min(minimum, curvature);
      maximum = Math.max(maximum, curvature);
    }
    // 真实直边/规则曲线的曲率跨采样率仍一致；重复滤波会造成无噪声圆弧缩径与拖尾。
    // 使用至少60ms的观测窗口，不能凭几个高频波峰就认定曲率稳定。
    if (maximum - minimum > Math.max(Math.abs(minimum), Math.abs(maximum)) * 0.15 + 1e-5) return;
    this.trace[this.trace.length - 1] = end.point;
    this.state.value = this.state.raw;
  }

  private protectCorner(): void {
    const count = this.observations.length;
    if (count < 5) return;
    const [a, b, c, d, e] = this.observations.slice(-5);
    if (a!.time === undefined || e!.time === undefined || e!.time - a!.time > 120) return;
    const before = { x: c!.point.x - a!.point.x, y: c!.point.y - a!.point.y };
    const after = { x: e!.point.x - c!.point.x, y: e!.point.y - c!.point.y };
    const first = Math.hypot(before.x, before.y),
      second = Math.hypot(after.x, after.y);
    if (
      Math.min(first, second) * this.scale < 4 ||
      (before.x * after.x + before.y * after.y) / (first * second) > Math.SQRT1_2
    )
      return;
    // 两侧须有足够长且一致的直边，不能把高频抖动的每个折点都升级成真实角点。
    if (
      segmentDistance(b!.point, a!.point, c!.point) * this.scale > 0.2 ||
      segmentDistance(d!.point, c!.point, e!.point) * this.scale > 0.2
    )
      return;
    this.corners.add(count - 3);
    for (let i = count - 3; i < count; i++) {
      this.displayed[i] = this.observations[i]!.point;
    }
    // 停笔区域只接受追加的运动观测，不能因修复显示角点而回写它已经统计过的历史。
    this.trace[count - 1] = this.observations[count - 1]!.point;
    this.state.value = this.state.raw;
  }

  /**
   * 停笔后结合正反两个方向消除单向滤波拖尾，给静态分类和拟合提供同一份轨迹。
   * @returns 独立快照；首末点、明确角点及压力保留真实观测，原始轨迹不修改。
   * @throws 不抛异常；采样已经在追加时完成时间和坐标契约校验。
   */
  snapshot(): InkPoint[] {
    if (this.observations.some(({ time }) => time === undefined))
      return this.trace.map((point) => ({ ...point }));
    const last = this.observations.at(-1)!;
    const backward = new InkSmoother(last.point, this.scale, 0);
    for (let i = this.observations.length - 2; i >= 0; i--)
      backward.push(this.observations[i]!.point, last.time! - this.observations[i]!.time!);
    const count = this.observations.length;
    return this.observations.map(({ point }, i) => {
      if (i === 0 || i === count - 1 || this.corners.has(i) || backward.corners.has(count - 1 - i))
        return { ...point };
      const a = this.trace[i]!,
        b = backward.trace[count - 1 - i]!;
      return { x: a.x + (b.x - a.x) / 2, y: a.y + (b.y - a.y) / 2, pressure: point.pressure };
    });
  }
}
