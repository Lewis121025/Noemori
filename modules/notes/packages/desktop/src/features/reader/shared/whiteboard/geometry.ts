import type { InkPoint, InkStroke } from "./model";

/** 屏幕坐标 = 世界坐标 × scale + 平移；设备像素比只属于渲染。 */
export type BoardViewport = { readonly x: number; readonly y: number; readonly scale: number };
/** 常规缩放下限；完整适配大画布后由输入状态机保留更小的下限。 */
export const DEFAULT_MIN_SCALE = 0.1;
const MAX_SCALE = 8;
/** 圈选、命中与预览使用同一份世界坐标边界。 */
export type InkBounds = { x: number; y: number; width: number; height: number };
type Point = { readonly x: number; readonly y: number };

function checkedViewport(view: BoardViewport): BoardViewport {
  if (![view.x, view.y, view.scale].every(Number.isFinite) || view.scale <= 0)
    throw new Error("白板视口包含无效坐标或比例");
  return view;
}

/**
 * 将画布内的屏幕点还原为世界坐标，不修改视口。
 * @param view 平移为屏幕像素、比例为正数的视口。
 * @param x 画布内的屏幕横坐标。
 * @param y 画布内的屏幕纵坐标。
 * @returns 对应世界坐标；内容边界由输入状态机继续校验。
 * @throws 参数或结果非有限，或者比例非正时拒绝转换。
 */
export function toWorld(view: BoardViewport, x: number, y: number): Point {
  checkedViewport(view);
  if (![x, y].every(Number.isFinite)) throw new Error("白板屏幕坐标无效");
  const point = { x: (x - view.x) / view.scale, y: (y - view.y) / view.scale };
  if (![point.x, point.y].every(Number.isFinite)) throw new Error("白板坐标转换溢出");
  return point;
}

/**
 * 以屏幕指针为不动点缩放；大画布适配后可以使用小于 0.1 的下限。
 * @param view 当前视口，不会被修改。
 * @param x 画布内的屏幕横坐标。
 * @param y 画布内的屏幕纵坐标。
 * @param factor 正的有限缩放倍数。
 * @param minimumScale 当前内容完整适配后的最小比例，范围为 (0, 8]。
 * @returns 已限制比例的新视口。
 * @throws 输入或结果非有限、比例非正或下限超出范围时拒绝修改。
 */
export function zoomAt(
  view: BoardViewport,
  x: number,
  y: number,
  factor: number,
  minimumScale = DEFAULT_MIN_SCALE,
): BoardViewport {
  if (
    !Number.isFinite(factor) ||
    factor <= 0 ||
    !Number.isFinite(minimumScale) ||
    minimumScale <= 0 ||
    minimumScale > MAX_SCALE
  )
    throw new Error("白板缩放参数无效");
  const point = toWorld(view, x, y);
  const scale = Math.max(minimumScale, Math.min(MAX_SCALE, view.scale * factor));
  return checkedViewport({ x: x - point.x * scale, y: y - point.y * scale, scale });
}

/**
 * 按屏幕像素平移相机，拖拽与滚轮共用数值校验。
 * @param view 当前视口，不会被修改。
 * @param dx 屏幕横向位移。
 * @param dy 屏幕纵向位移。
 * @returns 新视口；允许从内容边界之外移回。
 * @throws 参数或结果非有限时拒绝修改。
 */
export function translateViewport(view: BoardViewport, dx: number, dy: number): BoardViewport {
  checkedViewport(view);
  if (![dx, dy].every(Number.isFinite)) throw new Error("白板平移量无效");
  return checkedViewport({ ...view, x: view.x + dx, y: view.y + dy });
}

/** 计算笔迹边界并计入笔宽；空白板没有边界。 */
export function inkBounds(strokes: readonly InkStroke[]): InkBounds | null {
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  for (const stroke of strokes)
    for (const p of stroke.points) {
      left = Math.min(left, p.x - stroke.width / 2);
      top = Math.min(top, p.y - stroke.width / 2);
      right = Math.max(right, p.x + stroke.width / 2);
      bottom = Math.max(bottom, p.y + stroke.width / 2);
    }
  return left === Infinity ? null : { x: left, y: top, width: right - left, height: bottom - top };
}

/** 判断已校验的世界点是否落在边界内；margin 为世界单位余量，返回布尔命中结果。 */
export function insideBounds(p: Point, bounds: InkBounds, margin = 0): boolean {
  return (
    p.x >= bounds.x - margin &&
    p.x <= bounds.x + bounds.width + margin &&
    p.y >= bounds.y - margin &&
    p.y <= bounds.y + bounds.height + margin
  );
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pointSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  const t =
    length === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length));
  return Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t);
}

function cross(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function segmentDistance(a: Point, b: Point, c: Point, d: Point): number {
  if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) return 0;
  return Math.min(
    pointSegment(a, c, d),
    pointSegment(b, c, d),
    pointSegment(c, a, b),
    pointSegment(d, a, b),
  );
}

function insidePolygon(p: Point, polygon: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!,
      b = polygon[j]!;
    if (pointSegment(p, a, b) < 0.001) return true;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x)
      inside = !inside;
  }
  return inside;
}

function segmentInsidePolygon(a: Point, b: Point, polygon: readonly Point[]): boolean {
  if (!insidePolygon({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, polygon)) return false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const c = polygon[j]!,
      d = polygon[i]!;
    if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) return false;
  }
  return true;
}

/**
 * 闭合且达到最小面积的圈选只包含完整包围的笔迹；是否停笔确认由交互层决定。
 * @param points 已校验的世界坐标圈选轨迹，开放或退化轨迹返回空集合。
 * @param strokes 当前文档中已校验的笔迹，不会被修改。
 * @param scale 当前缩放，用于把手势阈值保持为固定屏幕距离。
 * @returns 被完整包围的笔迹身份，不产生内容事务。
 */
export function lassoSelection(
  points: readonly InkPoint[],
  strokes: readonly InkStroke[],
  scale: number,
): string[] {
  if (points.length < 6 || distance(points[0]!, points.at(-1)!) * scale > 14) return [];
  let area = 0,
    length = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!,
      b = points[i]!;
    // 以起点为局部原点计算三角扇面积，包含隐式闭合边且不受世界坐标平移影响。
    area += cross(points[0]!, a, b);
    length += distance(a, b);
  }
  if (Math.abs(area) * scale * scale < 800 || length * scale < 80) return [];
  return strokes
    .filter((stroke) =>
      stroke.points.every(
        (point, i) =>
          insidePolygon(point, points) &&
          (i === 0 || segmentInsidePolygon(stroke.points[i - 1]!, point, points)),
      ),
    )
    .map((stroke) => stroke.id);
}

/** 提取主轴上有足够距离的折返段，采样密度和手抖不能增加折返次数。 */
function scratchLegs(points: readonly InkPoint[], scale: number): (readonly InkPoint[])[] {
  if (points.length < 6) return [];
  const bounds = inkBounds([{ id: "gesture", width: 1, points }])!;
  const axis = bounds.width >= bounds.height ? "x" : "y";
  const threshold = Math.max(8 / scale, Math.max(bounds.width, bounds.height) * 0.3);
  const legs: (readonly InkPoint[])[] = [];
  let startIndex = 0,
    extremeIndex = 0;
  const first = points[0]!;
  let extreme = first,
    direction = 0;
  for (let i = 1; i < points.length; i++) {
    const point = points[i]!;
    if (direction === 0) {
      if (Math.abs(point[axis] - first[axis]) >= threshold) {
        direction = Math.sign(point[axis] - first[axis]);
        extreme = point;
        extremeIndex = i;
      }
    } else if ((point[axis] - extreme[axis]) * direction > 0) {
      extreme = point;
      extremeIndex = i;
    } else if ((point[axis] - extreme[axis]) * direction <= -threshold) {
      legs.push(points.slice(startIndex, extremeIndex + 1));
      startIndex = extremeIndex;
      extreme = point;
      extremeIndex = i;
      direction *= -1;
    }
  }
  if (direction !== 0) legs.push(points.slice(startIndex));
  return legs.length >= 5 ? legs : [];
}

function legHitsStroke(leg: readonly InkPoint[], stroke: InkStroke, tolerance: number): boolean {
  for (let i = 1; i < leg.length; i++) {
    const a = leg[i - 1]!,
      b = leg[i]!;
    if (stroke.points.length === 1 && pointSegment(stroke.points[0]!, a, b) <= tolerance)
      return true;
    for (let j = 1; j < stroke.points.length; j++) {
      if (segmentDistance(a, b, stroke.points[j - 1]!, stroke.points[j]!) <= tolerance) return true;
    }
  }
  return false;
}

/**
 * 只有连续折返且至少三次跨过同一笔迹才把涂划作为删除动作。
 * 空白涂划、普通交叉线和圆圈均保留为原始输入；返回值从不改变传入笔迹。
 * @param points 已校验的世界坐标手势轨迹。
 * @param strokes 当前文档中的有效笔迹。
 * @param scale 正的有限视口比例，用于把命中余量换算为世界单位。
 * @returns 命中的笔迹身份；不符合删除手势时返回空数组。
 */
export function erasedStrokes(
  points: readonly InkPoint[],
  strokes: readonly InkStroke[],
  scale: number,
): string[] {
  const legs = scratchLegs(points, scale);
  if (legs.length === 0) return [];
  return strokes
    .filter((stroke) => {
      let crossings = 0;
      for (const leg of legs) {
        if (legHitsStroke(leg, stroke, stroke.width / 2 + 3 / scale)) crossings += 1;
        if (crossings >= 3) return true;
      }
      return false;
    })
    .map((stroke) => stroke.id);
}

/**
 * 生成与命中几何一致的原始轨迹；圆形线帽和接头交给 SVG 渲染。
 * 不用跨采样点的拟合曲线改写拐角，单点也保留为可见圆端点。
 * @param points 已校验的世界坐标采样。
 * @returns SVG 路径数据；空采样返回空串。
 */
export function strokePath(points: readonly InkPoint[]): string {
  const first = points[0];
  if (!first) return "";
  if (points.length === 1) return `M${first.x} ${first.y}l0.001 0`;
  let path = `M${first.x} ${first.y}`;
  for (const point of points.slice(1)) path += `L${point.x} ${point.y}`;
  return path;
}
