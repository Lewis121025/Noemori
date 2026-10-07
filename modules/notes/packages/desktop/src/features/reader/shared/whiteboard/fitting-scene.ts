import { fitConicRelations } from "./fitting-conic-relations";
import { fitNestedContours } from "./fitting-nested";
import { fitBranchedArrows } from "./fitting-branched-arrows";
import { fitCylinders } from "./fitting-cylinder";
import { fitWireframe } from "./fitting-wireframe";
import { scenePrimitive } from "./fitting-primitives";
import { fitRelations } from "./fitting-relations";
import { repairShape } from "./fitting";
import { strokeGraph, graphWalk, splitGraphContour, type GraphTrace } from "./fitting-scene-graph";
import { contourDeviation, observationsAgree, resample, type FitPoint } from "./fitting-math";
import {
  parseShapeRepairRequest,
  type ShapeFit,
  type ShapeRepairRequest,
  type ShapeLabel,
} from "./recognition";
import type { InkPoint } from "./model";

/** 组内所有轮廓共用归一化和完整观测，避免不同尺寸的容差发生错配。 */
export type SceneFrame = {
  traces: GraphTrace[];
  size: number;
  cx: number;
  cy: number;
  scale: number;
  pressure: number[];
};
/** 候选只修改参与证明的笔画；未参与笔画不进入返回事务。 */
export type SceneFit = { label: ShapeLabel; paths: Map<number, FitPoint[]>; parameters: number };

/**
 * 形成有限同坐标场景；单笔误差预算继续按自身尺寸计算，不由场景外包框放大。
 * @param request 已经过跨进程契约校验的完整请求。
 * @returns 共享坐标变换和保留全观测的笔迹；退化尺寸返回null，不抛异常。
 */
export function prepareScene(request: ShapeRepairRequest): SceneFrame | null {
  const inputs = [
    { points: request.points, observations: request.observations },
    ...(request.context ?? []),
  ];
  const all = inputs.flatMap((s) => s.points),
    xs = all.map((p) => p.x),
    ys = all.map((p) => p.y),
    left = Math.min(...xs),
    right = Math.max(...xs),
    top = Math.min(...ys),
    bottom = Math.max(...ys),
    size = Math.max(right - left, bottom - top),
    cx = (left + right) / 2,
    cy = (top + bottom) / 2;
  if (!Number.isFinite(size * request.scale) || size * request.scale < 16) return null;
  const normalize = (p: InkPoint) => ({ x: (p.x - cx) / size, y: (p.y - cy) / size });
  return {
    size,
    cx,
    cy,
    scale: request.scale,
    pressure: inputs.map((s) => s.points.reduce((sum, p) => sum + p.pressure, 0) / s.points.length),
    traces: inputs.map((s, index) => ({
      index,
      points: s.points.map(normalize),
      observations: s.observations.map(normalize),
    })),
  };
}

function connectedContour(frame: SceneFrame): SceneFit | null {
  const graph = strokeGraph(frame.traces, 0, 5 / (frame.size * frame.scale)),
    visits = graphWalk(graph);
  if (!visits) return null;
  const source: FitPoint[] = [],
    observed: FitPoint[] = [];
  for (const { edge, reversed } of visits) {
    source.push(...(reversed ? [...edge.trace.points].reverse() : edge.trace.points));
    observed.push(...edge.trace.observations);
  }
  if (observed.length > 8192) return null;
  const world = (p: FitPoint): InkPoint => ({
    x: frame.cx + p.x * frame.size,
    y: frame.cy + p.y * frame.size,
    pressure: 0.5,
  });
  const fit = repairShape(resample(source, 512).map(world), frame.scale, observed.map(world));
  if (!fit) return null;
  const contour = fit.points.map((p) => ({
      x: (p.x - frame.cx) / frame.size,
      y: (p.y - frame.cy) / frame.size,
    })),
    paths = splitGraphContour(contour, visits, graph.nodes);
  return paths ? { label: fit.label, paths, parameters: contour.length * 2 } : null;
}

/**
 * 每笔分别做双向覆盖与全观测验收，防止组内另一条边替它掩盖缺失或附加线。
 * @param frame 共享世界归一化场景。
 * @param fit 仅含实际参与笔迹的规范候选。
 * @returns 全部笔迹均在有界误差内时的RMS；任何失效索引或遗漏活动笔迹返回null。
 */
export function sceneError(frame: SceneFrame, fit: SceneFit): number | null {
  if (!fit.paths.has(0) || fit.paths.size < 2) return null;
  let squared = 0,
    count = 0;
  for (const [index, points] of fit.paths) {
    const trace = frame.traces[index];
    if (
      !trace ||
      points.length < 2 ||
      points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))
    )
      return null;
    const error = contourDeviation(trace.points, points);
    const xs = trace.points.map((p) => p.x),
      ys = trace.points.map((p) => p.y),
      extent = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)),
      maximum = Math.max(0.12 * extent, 3 / (frame.size * frame.scale)),
      rms = Math.max(0.055 * extent, 1 / (frame.size * frame.scale));
    if (
      extent * frame.size * frame.scale < 4 ||
      !error ||
      error.maximum > maximum ||
      error.rms > rms ||
      !observationsAgree(trace.observations, points, maximum)
    )
      return null;
    squared += error.rms ** 2;
    count++;
  }
  return Math.sqrt(squared / count);
}

/**
 * 停笔修复当前笔迹与有几何证据的相关笔迹；单笔处理和场景联动共用原观测契约。
 * @param input 有界静态点列、缩放和最多16条上下文。
 * @returns 当前规范轮廓与参与联动的身份替换；无可靠候选时保留笔迹返回null。
 * @throws 非法请求与数值运行错误向上传播，不以空白几何掩盖异常。
 */
export function repairScene(input: ShapeRepairRequest): ShapeFit | null {
  const request = parseShapeRepairRequest(input),
    frame = request.context?.length ? prepareScene(request) : null;
  if (frame) {
    const primitives = frame.traces.flatMap((trace) => {
      const primitive = scenePrimitive(trace, Math.min(0.015, 3 / (frame.size * frame.scale)));
      return primitive ? [primitive] : [];
    });
    const arrow = fitBranchedArrows(
        frame.traces,
        0,
        Math.min(0.015, 3 / (frame.size * frame.scale)),
      ),
      contour = connectedContour(frame),
      candidates = [
        ...(arrow ? [arrow] : []),
        ...(contour ? [contour] : []),
        ...fitRelations(frame, primitives),
        ...fitConicRelations(frame, primitives),
        ...fitWireframe(frame, primitives),
        ...fitCylinders(frame, primitives),
      ];
    const eligible = candidates
      .flatMap((fit) => {
        const error = sceneError(frame, fit);
        return error === null ? [] : [{ fit, error }];
      })
      .sort((a, b) => b.fit.paths.size - a.fit.paths.size || a.error - b.error);
    // 完整连接轮廓先于孤立的两笔关系，避免只修一个角而忽略已成立的整圈。
    const nested = eligible.length === 0 ? fitNestedContours(frame) : null;
    const fit = eligible[0]?.fit ?? (nested && sceneError(frame, nested) !== null ? nested : null);
    if (fit) {
      const world = (index: number, points: readonly FitPoint[]): InkPoint[] =>
        points.map((p) => ({
          x: frame.cx + p.x * frame.size,
          y: frame.cy + p.y * frame.size,
          pressure: frame.pressure[index]!,
        }));
      return {
        label: fit.label,
        points: world(0, fit.paths.get(0)!),
        replacements: [...fit.paths].flatMap(([index, points]) =>
          index === 0
            ? []
            : [{ id: request.context![index - 1]!.id, points: world(index, points) }],
        ),
      };
    }
  }
  return repairShape(request.points, request.scale, request.observations);
}
