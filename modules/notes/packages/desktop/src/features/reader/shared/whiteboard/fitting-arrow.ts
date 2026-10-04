import { contourHull, distance, type FitPoint } from "./fitting-math";

/** 最大面积凸四边形只提取箭头的三个端点和连接点；不是分类或最终误差判断。 */
function corners(points: readonly FitPoint[]): FitPoint[] | null {
  const hull = contourHull(points);
  if (hull.length < 4) return null;
  const area = (a: FitPoint, b: FitPoint, c: FitPoint) =>
    Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
  let best = 0,
    result: FitPoint[] | null = null;
  // 任意凸四边形可按对角线拆成两侧三角形；各侧独立最大化，避免四重穷举。
  for (let i = 0; i < hull.length - 3; i++) {
    const a = hull[i]!;
    for (let j = i + 2; j < hull.length - 1; j++) {
      const c = hull[j]!;
      let left = i + 1,
        right = j + 1;
      for (let k = i + 2; k < j; k++) if (area(a, hull[k]!, c) > area(a, hull[left]!, c)) left = k;
      for (let k = j + 2; k < hull.length; k++)
        if (area(a, c, hull[k]!) > area(a, c, hull[right]!)) right = k;
      const current = area(a, hull[left]!, c) + area(a, c, hull[right]!);
      if (current > best) {
        best = current;
        result = [a, hull[left]!, c, hull[right]!];
      }
    }
  }
  return result;
}

/** 单点在某一分支上的投影；along从箭尖计量，error保留对应的垂直偏差。 */
type BranchProjection = { branch: number; along: number; error: number };

/** 同分支沿边移动，跨分支必须经过箭尖；不使用会低估必要回程的欧氏距离。 */
function branchDistance(a: BranchProjection, b: BranchProjection): number {
  return a.branch === b.branch ? Math.abs(a.along - b.along) : a.along + b.along;
}

/** 结合相邻采样位置选择连续投影，避免连接点附近的分支身份因噪声来回翻转。 */
function alignBranches(
  source: readonly FitPoint[],
  projections: BranchProjection[][],
): BranchProjection[] {
  // 连接点附近逐点选最近分支会被抖动反复翻转；用完整序列最小化投影误差和不连续跳跃。
  // 两项都用距离平方，不引入额外容差；实际大范围往返仍由下方覆盖预算拒绝。
  const previous: number[][] = [];
  let costs = projections[0]!.map((point) => point.error * point.error);
  for (let i = 1; i < projections.length; i++) {
    const step = distance(source[i - 1]!, source[i]!);
    const back: number[] = [];
    costs = projections[i]!.map((point) => {
      let best = Infinity,
        choice = 0;
      for (let branch = 0; branch < projections[i - 1]!.length; branch++) {
        const jump = Math.max(0, branchDistance(projections[i - 1]![branch]!, point) - step);
        const cost = costs[branch]! + jump * jump;
        if (cost < best) {
          best = cost;
          choice = branch;
        }
      }
      back.push(choice);
      return best + point.error * point.error;
    });
    previous.push(back);
  }
  let choice = costs.indexOf(Math.min(...costs));
  const positions = [projections.at(-1)![choice]!];
  for (let i = projections.length - 1; i > 0; i--) {
    choice = previous[i - 1]![choice]!;
    positions.push(projections[i - 1]![choice]!);
  }
  positions.reverse();
  return positions;
}

/** 在三分支树上统计额外往返；必要的箭翼/主干回程由起止位置决定，不能算成涂划。 */
function followsBranches(source: readonly FitPoint[], fitted: readonly FitPoint[]): boolean {
  const tip = fitted[1]!;
  const ends = [fitted[0]!, fitted[2]!, fitted[4]!];
  const lengths = ends.map((end) => distance(tip, end));
  const projections = source.map((point) =>
    ends.map((end, branch) => {
      const length = lengths[branch]!;
      const dx = end.x - tip.x,
        dy = end.y - tip.y;
      const t = Math.max(
        0,
        Math.min(1, ((point.x - tip.x) * dx + (point.y - tip.y) * dy) / (length * length)),
      );
      const error = Math.hypot(point.x - tip.x - t * dx, point.y - tip.y - t * dy);
      return { branch, along: t * length, error };
    }),
  );
  const positions = alignBranches(source, projections);
  const travel = positions
    .slice(1)
    .reduce((sum, point, i) => sum + branchDistance(positions[i]!, point), 0);
  // 树上覆盖全部分支的最短连续遍历为“两倍总边长减去起止点之间的树距离”。
  // 几何覆盖仍由原始笔迹的双向距离校验负责，这里只限制超出必要遍历的重描。
  const required =
    2 * lengths.reduce((sum, length) => sum + length, 0) -
    branchDistance(positions[0]!, positions.at(-1)!);
  // 与traceAdvance的“反向距离不超过净推进1/8”相同；一次额外往返包含反向和正向两程。
  return Number.isFinite(travel) && travel - required <= required / 4 + 1e-8;
}

/** 从主干和两翼建立对称候选；比例与方向约束沿用既有箭头契约。 */
function candidate(start: FitPoint, tip: FitPoint, ends: readonly FitPoint[]): FitPoint[] | null {
  const length = distance(start, tip);
  if (length < 0.5) return null;
  const dx = (tip.x - start.x) / length,
    dy = (tip.y - start.y) / length;
  const wings = ends.map((point) => ({
    x: (point.x - tip.x) * dx + (point.y - tip.y) * dy,
    y: -(point.x - tip.x) * dy + (point.y - tip.y) * dx,
  }));
  if (wings[0]!.y * wings[1]!.y >= 0 || wings.some((point) => point.x > -0.06)) return null;
  const head = -(wings[0]!.x + wings[1]!.x) / 2;
  const width = (Math.abs(wings[0]!.y) + Math.abs(wings[1]!.y)) / 2;
  if (head > length * 0.45 || width < 0.04 || width > length * 0.4) return null;
  const wing = (side: number) => ({
    x: tip.x - head * dx - side * width * dy,
    y: tip.y - head * dy + side * width * dx,
  });
  return [start, tip, wing(-1), tip, wing(1)];
}

/**
 * 按静态三分支轮廓拟合单笔开放箭头，起笔顺序和最后是否回到连接点不改变结构。
 * @param points 已校验的有限归一化轨迹，调用方限制为192个弧长采样点。
 * @returns 规范主干和对称两翼；退化、方向不符或过量重描返回 null，不抛异常。
 * 调用方还必须用原始采样验证双向轮廓误差，不能仅凭四个角点接受图形。
 */
export function fitArrow(points: readonly FitPoint[]): FitPoint[] | null {
  const vertices = corners(points);
  if (!vertices) return null;
  let first = 0,
    second = 1,
    longest = 0;
  for (let i = 0; i < vertices.length - 1; i++)
    for (let j = i + 1; j < vertices.length; j++) {
      const length = distance(vertices[i]!, vertices[j]!);
      if (length > longest) {
        longest = length;
        first = i;
        second = j;
      }
    }
  const wings = vertices.filter((_, i) => i !== first && i !== second);
  for (const [start, tip] of [
    [first, second],
    [second, first],
  ]) {
    const fitted = candidate(vertices[start!]!, vertices[tip!]!, wings);
    if (fitted && followsBranches(points, fitted)) return fitted;
  }
  return null;
}
