/**
 * 图谱画布的视口数学：世界坐标与屏幕坐标互换、以指针为中心缩放、适配全图与命中测试。
 *
 * 屏幕坐标以画布左上角为原点、CSS 像素为单位；设备像素比由绘制层处理。
 */

/** 视口：屏幕点 = 世界点 × `k` + (`x`, `y`)。 */
export type Viewport = { readonly x: number; readonly y: number; readonly k: number };

/** 缩放范围；过小时节点叠成一点，过大时单个节点占满画布，都没有阅读价值。 */
export const ZOOM_MIN = 0.05;
export const ZOOM_MAX = 8;
/** 自动适配的放大上限：小图放大到易读即可，不把三五个节点撑满整个画布。 */
export const FIT_ZOOM_MAX = 2;

/** 屏幕点转世界点。 */
export function toWorld(view: Viewport, sx: number, sy: number): [number, number] {
  return [(sx - view.x) / view.k, (sy - view.y) / view.k];
}

/** 以屏幕点 (`sx`, `sy`) 为不动点缩放 `factor` 倍，缩放倍数收敛到允许范围。 */
export function zoomAt(view: Viewport, factor: number, sx: number, sy: number): Viewport {
  const k = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, view.k * factor));
  const [wx, wy] = toWorld(view, sx, sy);
  return { k, x: sx - wx * k, y: sy - wy * k };
}

/**
 * 让全部节点居中落进画布，四周留 `padding` 像素。
 *
 * @param positions 交错排列的世界坐标 `[x0, y0, x1, y1, …]`。
 * @returns 没有节点时返回以原点为中心的单位视口；放大不超过 {@link FIT_ZOOM_MAX}。
 */
export function fitViewport(
  positions: ArrayLike<number>,
  width: number,
  height: number,
  padding = 24,
): Viewport {
  const count = Math.floor(positions.length / 2);
  if (count === 0) return { x: width / 2, y: height / 2, k: 1 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let index = 0; index < count; index += 1) {
    const x = positions[index * 2]!;
    const y = positions[index * 2 + 1]!;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const spanX = Math.max(maxX - minX, 1);
  const spanY = Math.max(maxY - minY, 1);
  const k = Math.min(
    FIT_ZOOM_MAX,
    Math.max(ZOOM_MIN, Math.min((width - padding * 2) / spanX, (height - padding * 2) / spanY)),
  );
  return {
    k,
    x: width / 2 - ((minX + maxX) / 2) * k,
    y: height / 2 - ((minY + maxY) / 2) * k,
  };
}

/**
 * 找屏幕点命中的节点：落在节点圆内（屏幕上至少 `slop` 像素）的节点里取最近的一个。
 *
 * @param radii 每个节点的世界半径。
 * @returns 节点下标；没有命中时为 -1。
 */
export function hitNode(
  view: Viewport,
  positions: ArrayLike<number>,
  radii: ArrayLike<number>,
  sx: number,
  sy: number,
  slop = 4,
): number {
  const [wx, wy] = toWorld(view, sx, sy);
  let best = -1;
  let bestDistance = Infinity;
  for (let index = 0; index < radii.length; index += 1) {
    const dx = positions[index * 2]! - wx;
    const dy = positions[index * 2 + 1]! - wy;
    const distance = Math.hypot(dx, dy);
    const reach = Math.max(radii[index]!, slop / view.k);
    if (distance <= reach && distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  }
  return best;
}
