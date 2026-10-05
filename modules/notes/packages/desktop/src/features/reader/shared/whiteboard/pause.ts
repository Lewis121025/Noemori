import type { InkPoint } from "./model";
import type { FitPoint } from "./fitting-math";

/** 停笔计时基准与观测覆盖圆；移动前缀完整保留，reset 记录最近一次重启计时的位置。 */
export type PauseRegion = {
  center: FitPoint;
  enclosing: FitPoint;
  start: number;
  reset: number;
};

/** 确认停笔后的静态轨迹及对应计时区域；两者共享稳定末点，原始观测由输入会话保留。 */
export type PauseSnapshot = { points: InkPoint[]; pause: PauseRegion };

type Circle = { center: FitPoint; radiusSquared: number };

function squared(a: FitPoint, b: FitPoint): number {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
}

function contains(circle: Circle, point: FitPoint): boolean {
  return squared(circle.center, point) <= circle.radiusSquared + 1e-10;
}

function diameter(a: FitPoint, b: FitPoint): Circle {
  const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  return { center, radiusSquared: squared(center, a) };
}

function through(a: FitPoint, b: FitPoint, c: FitPoint): Circle {
  const bx = b.x - a.x,
    by = b.y - a.y,
    cx = c.x - a.x,
    cy = c.y - a.y;
  const cross = bx * cy - by * cx;
  if (cross === 0) {
    const circles = [diameter(a, b), diameter(a, c), diameter(b, c)];
    return circles.reduce((best, circle) =>
      circle.radiusSquared > best.radiusSquared ? circle : best,
    );
  }
  const bb = bx * bx + by * by,
    cc = cx * cx + cy * cy;
  const center = {
    x: a.x + (cy * bb - by * cc) / (2 * cross),
    y: a.y + (bx * cc - cx * bb) / (2 * cross),
  };
  return { center, radiusSquared: squared(center, a) };
}

/** 固定洗牌的增量最小覆盖圆；局部归一化后求解，避免大世界坐标的消减误差。 */
function enclosingCircle(
  points: readonly InkPoint[],
  start: number,
  radius: number,
): { center: FitPoint; fits: boolean } {
  const origin = points.at(-1)!;
  const local = points.slice(start).map((point) => ({
    x: (point.x - origin.x) / radius,
    y: (point.y - origin.y) / radius,
  }));
  let seed = 0x9e3779b9;
  for (let i = local.length - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const j = seed % (i + 1);
    [local[i], local[j]] = [local[j]!, local[i]!];
  }
  let circle: Circle = { center: local[0]!, radiusSquared: 0 };
  for (let i = 1; i < local.length; i++) {
    const a = local[i]!;
    if (contains(circle, a)) continue;
    circle = { center: a, radiusSquared: 0 };
    for (let j = 0; j < i; j++) {
      const b = local[j]!;
      if (contains(circle, b)) continue;
      circle = diameter(a, b);
      for (let k = 0; k < j; k++)
        if (!contains(circle, local[k]!)) circle = through(a, b, local[k]!);
    }
  }
  return {
    center: { x: origin.x + circle.center.x * radius, y: origin.y + circle.center.y * radius },
    fits: circle.radiusSquared <= 1 + 1e-10,
  };
}

/**
 * 追加观测后更新覆盖圆；越过计时基准才更新 reset，不能随慢速绘制漂移。
 * @param points 已校验的完整原始采样，末项为本次真实观测，至少一项。
 * @param previous 上次区域；索引必须对应同一条只追加、不删除的原始笔迹。
 * @param radius 正的有限世界坐标半径，由固定 CSS 像素半径除以相机缩放得到。
 * @returns start 对应最长可覆盖后缀；计时基准与覆盖圆分离，不能因更新统计范围淘汰请求。
 * @throws 半径无效时抛出 RangeError；调用方负责校验点与索引。
 */
export function advancePause(
  points: readonly InkPoint[],
  previous: PauseRegion,
  radius: number,
): PauseRegion {
  if (!(radius > 0) || !Number.isFinite(radius))
    throw new RangeError("静止区域半径必须为正的有限值");
  const last = points.at(-1)!;
  const outside = Math.hypot(last.x - previous.center.x, last.y - previous.center.y) > radius;
  if (
    !outside &&
    Math.hypot(last.x - previous.enclosing.x, last.y - previous.enclosing.y) <= radius
  )
    return previous;
  let low = previous.start;
  // 相距超过直径的观测不可能同时静止，先排除它们以限制每次指针事件的求解范围。
  for (let i = points.length - 2; i >= low; i--)
    if (Math.hypot(points[i]!.x - last.x, points[i]!.y - last.y) > 2 * radius) {
      low = i + 1;
      break;
    }
  let start = low,
    circle = enclosingCircle(points, low, radius);
  if (!circle.fits) {
    let high = points.length - 1;
    // 后缀能否被覆盖具有单调性；二分找到移动与静止观测的边界。
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = enclosingCircle(points, middle, radius);
      if (candidate.fits) high = middle;
      else low = middle + 1;
    }
    start = low;
    circle = enclosingCircle(points, start, radius);
  }
  // 移动前缀推进时计时基准跟随真实末点；后缀边界未推进的重复观测才能使区域居中。
  // 首次两点观察不足以区分连续绘制与停笔，仍以末点计时，后续可覆盖的返回观测消除偏心。
  const center = outside
    ? start === previous.start && previous.start < previous.reset
      ? circle.center
      : last
    : previous.center;
  return {
    center,
    enclosing: circle.center,
    start,
    reset: outside ? points.length - 1 : previous.reset,
  };
}

/**
 * 停笔时把区域内重复位置观测归并为一个末点，避免把传感器抖动按行走弧长加权。
 * @param points 完整原始采样；原数组和压力均不修改，失败回退仍可保存真实笔迹。
 * @param pause 同一笔的静止区域；最近重启计时后没有新增观测时保持原几何。
 * @param radius 同一笔的世界坐标停笔半径；只有超过直径的重复往返量才属于可归并观测。
 * @returns 独立静态快照与稳定计时区域；原始观测仍须检查最大偏差，不产生文档事务。
 * @throws 不抛异常；点、索引与非空前置条件由输入状态机保证。
 */
export function preparePause(
  points: readonly InkPoint[],
  pause: PauseRegion,
  radius: number,
): PauseSnapshot {
  const original = { points: points.map((point) => ({ ...point })), pause };
  if (pause.reset === points.length - 1) return original;
  const origin = points[pause.start]!;
  let travel = 0;
  for (let i = pause.start + 1; i < points.length; i++)
    travel += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
  const last = points.at(-1)!;
  // 慢速收笔与角点也会留在小区域内；空间有界不等于重复观测，不能把它们平均成短尾。
  if (travel - Math.hypot(last.x - origin.x, last.y - origin.y) <= 2 * radius) return original;
  let start = pause.start;
  while (start < points.length - 1) {
    const origin = points[start]!;
    const count = points.length - start;
    let x = 0,
      y = 0,
      pressure = 0;
    for (let i = start; i < points.length; i++) {
      x += points[i]!.x - origin.x;
      y += points[i]!.y - origin.y;
      pressure += points[i]!.pressure;
    }
    const endpoint = {
      x: origin.x + x / count,
      y: origin.y + y / count,
      pressure: pressure / count,
    };
    let next = start;
    // 覆盖圆允许包含距重心较远的移动末段；这些点必须留在几何前缀，不能被一起平均。
    for (let i = points.length - 1; i >= start; i--)
      if (Math.hypot(points[i]!.x - endpoint.x, points[i]!.y - endpoint.y) > radius) {
        next = i + 1;
        break;
      }
    if (next === start)
      return {
        points: [...original.points.slice(0, start), endpoint],
        // 450ms确认停笔后，计时和结果失效基准均落在同一个稳定末点，避免预览被偏心区域反复取消。
        pause: { center: endpoint, enclosing: endpoint, start, reset: pause.reset },
      };
    start = next;
  }
  return original;
}
