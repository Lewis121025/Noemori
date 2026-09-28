/**
 * 图谱力导向布局：d3-force 的纯计算，不接触 DOM。
 *
 * 在 Worker 里逐步推进并把坐标分帧送回主线程；Node 环境下可直接调用做性能验收。
 * 数据用定长类型数组传递，Worker 边界可以零拷贝转移。
 */

import {
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";

/** 一次布局请求。 */
export type LayoutRequest = {
  /** 节点数。 */
  readonly count: number;
  /** 边的端点下标，交错排列 `[source0, target0, source1, target1, …]`。 */
  readonly links: Uint32Array;
  /** 上一轮坐标，交错排列 `[x0, y0, …]`；`NaN` 表示新节点。长度为 `count * 2`。 */
  readonly seeds: Float32Array;
};

type Body = SimulationNodeDatum;

/** 多数节点沿用旧坐标时只轻推一下，避免增量刷新把熟悉的布局整体打乱。 */
const WARM_ALPHA = 0.3;

/**
 * 一次可逐步推进的布局。
 *
 * 构造时完成播种：沿用旧坐标；新节点放在已播种邻居的重心附近，
 * 没有已播种邻居时交给 d3 的默认螺旋初始位置。
 */
export class LayoutRun {
  private readonly bodies: Body[];
  private readonly simulation: Simulation<Body, SimulationLinkDatum<Body>>;

  constructor(request: LayoutRequest) {
    const { count, links, seeds } = request;
    this.bodies = Array.from({ length: count }, (): Body => ({}));
    let seeded = 0;
    for (let index = 0; index < count; index += 1) {
      const x = seeds[index * 2]!;
      const y = seeds[index * 2 + 1]!;
      if (Number.isNaN(x) || Number.isNaN(y)) continue;
      this.bodies[index] = { x, y };
      seeded += 1;
    }
    if (seeded > 0 && seeded < count) this.placeNewcomers(links, seeds);
    const edges: SimulationLinkDatum<Body>[] = [];
    for (let index = 0; index + 1 < links.length; index += 2)
      edges.push({ source: links[index]!, target: links[index + 1]! });
    // 大图减少迭代：五千节点时每步开销以毫秒计，全量衰减会让首屏等待过长。
    const decay = count > 2000 ? 0.05 : 0.0228;
    this.simulation = forceSimulation(this.bodies)
      .force("link", forceLink<Body, SimulationLinkDatum<Body>>(edges).distance(36))
      .force("charge", forceManyBody<Body>().strength(-40).theta(1).distanceMax(400))
      .force("x", forceX<Body>(0).strength(0.04))
      .force("y", forceY<Body>(0).strength(0.04))
      .alphaDecay(decay)
      .stop();
    if (seeded * 2 >= count && count > 0) this.simulation.alpha(WARM_ALPHA);
  }

  private placeNewcomers(links: Uint32Array, seeds: Float32Array): void {
    const sums = new Map<number, { x: number; y: number; n: number }>();
    const visit = (from: number, to: number) => {
      if (this.bodies[from]!.x !== undefined || Number.isNaN(seeds[to * 2]!)) return;
      const sum = sums.get(from) ?? { x: 0, y: 0, n: 0 };
      sum.x += seeds[to * 2]!;
      sum.y += seeds[to * 2 + 1]!;
      sum.n += 1;
      sums.set(from, sum);
    };
    for (let index = 0; index + 1 < links.length; index += 2) {
      visit(links[index]!, links[index + 1]!);
      visit(links[index + 1]!, links[index]!);
    }
    for (const [index, sum] of sums) {
      // 固定的小偏移：同一邻居带来的多个新节点不能叠在同一点，否则斥力方向无定义。
      const angle = index * 2.399963;
      this.bodies[index] = {
        x: sum.x / sum.n + Math.cos(angle) * 12,
        y: sum.y / sum.n + Math.sin(angle) * 12,
      };
    }
  }

  /**
   * 推进 `ticks` 步。
   * @returns 布局是否已经收敛（alpha 低于停止阈值）。
   */
  step(ticks: number): boolean {
    if (this.done) return true;
    this.simulation.tick(ticks);
    return this.done;
  }

  /** 是否已收敛。 */
  get done(): boolean {
    return this.simulation.alpha() < this.simulation.alphaMin();
  }

  /** 当前坐标的新副本，交错排列 `[x0, y0, …]`。 */
  positions(): Float32Array {
    const out = new Float32Array(this.bodies.length * 2);
    for (const [index, body] of this.bodies.entries()) {
      out[index * 2] = body.x ?? 0;
      out[index * 2 + 1] = body.y ?? 0;
    }
    return out;
  }
}

/**
 * 按路径记住节点坐标，跨过滤、深度切换与增量刷新复用。
 *
 * 只增不删：被过滤掉的节点重新出现时回到原处，而不是重新找位置。
 */
export class PositionMemory {
  private readonly known = new Map<string, readonly [number, number]>();

  /** 按节点顺序生成播种坐标；没记过的节点为 `NaN`。 */
  seeds(paths: readonly string[]): Float32Array {
    const out = new Float32Array(paths.length * 2).fill(Number.NaN);
    for (const [index, path] of paths.entries()) {
      const seed = this.known.get(path);
      if (seed === undefined) continue;
      out[index * 2] = seed[0];
      out[index * 2 + 1] = seed[1];
    }
    return out;
  }

  /** 记下一帧坐标；`positions` 与 `paths` 同序交错排列。 */
  remember(paths: readonly string[], positions: ArrayLike<number>): void {
    for (const [index, path] of paths.entries())
      this.known.set(path, [positions[index * 2]!, positions[index * 2 + 1]!]);
  }
}

/** 同步跑完整个布局；供测试与没有 Worker 的环境使用。 */
export function computeLayout(request: LayoutRequest): Float32Array {
  const run = new LayoutRun(request);
  while (!run.step(10));
  return run.positions();
}
