import { BOARD_COORDINATE_LIMIT, type InkPoint } from "./model";

/** 由轨迹结构与几何拟合产生的类型；任意边数的边段不受训练类别数量限制。 */
const SHAPE_LABELS = [
  "line",
  "circle",
  "ellipse",
  "arc",
  "rectangle",
  "triangle",
  "arrow",
  "star",
  "polygon",
  "polyline",
] as const;
/** 规范几何的类别，无法修复时使用null，不伪造未知类或置信分数。 */
export type ShapeLabel = (typeof SHAPE_LABELS)[number];
/** 已通过完整观测校验的规范轮廓；持久化继续使用既有点列格式。 */
export type ShapeFit = { label: ShapeLabel; points: InkPoint[] };
/** 一次停笔请求的输入契约；静态轨迹与原始观测使用同一世界坐标。 */
export type ShapeRepairRequest = {
  points: readonly InkPoint[];
  observations: readonly InkPoint[];
  scale: number;
};
/** 后台几何计算接口；拒绝返回null，运行或协议错误通过Promise拒绝。 */
export type ShapeRepair = (request: ShapeRepairRequest) => Promise<ShapeFit | null>;
/** 有界输入，防止后台计算或IPC被无上限点列占用。 */
export const RECOGNITION_POINT_LIMIT = 8192;
/** 停笔静止区域的CSS像素半径，由输入计时与几何顺序去抖共用。 */
export const HOLD_RADIUS_CSS_PX = 3;

/** 校验跨进程的完整采样副本；非法数量、坐标或压力抛错，不截断输入。 */
export function parseRecognitionPoints(value: unknown): InkPoint[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > RECOGNITION_POINT_LIMIT)
    throw new Error("图形识别采样数量无效");
  return value.map((point: unknown): InkPoint => {
    if (
      typeof point !== "object" ||
      point === null ||
      !("x" in point) ||
      !("y" in point) ||
      !("pressure" in point) ||
      typeof point.x !== "number" ||
      typeof point.y !== "number" ||
      typeof point.pressure !== "number" ||
      ![point.x, point.y, point.pressure].every(Number.isFinite) ||
      Math.abs(point.x) > BOARD_COORDINATE_LIMIT ||
      Math.abs(point.y) > BOARD_COORDINATE_LIMIT ||
      point.pressure < 0 ||
      point.pressure > 1
    )
      throw new Error("图形识别采样无效");
    return { x: point.x, y: point.y, pressure: point.pressure };
  });
}

/** 校验后台几何计算请求；非法缩放、静态轨迹或原始观测抛错，不截断输入。 */
export function parseShapeRepairRequest(value: unknown): ShapeRepairRequest {
  if (
    typeof value !== "object" ||
    value === null ||
    !("points" in value) ||
    !("observations" in value) ||
    !("scale" in value) ||
    typeof value.scale !== "number" ||
    !Number.isFinite(value.scale) ||
    value.scale <= 0
  )
    throw new Error("图形修复请求无效");
  return {
    points: parseRecognitionPoints(value.points),
    observations: parseRecognitionPoints(value.observations),
    scale: value.scale,
  };
}

/** 校验返回的规范几何或拒绝；未知类型和非法点列抛错，不能隐藏跨进程失败。 */
export function parseShapeFit(value: unknown): ShapeFit | null {
  if (value === null) return null;
  if (typeof value !== "object" || value === null || !("label" in value) || !("points" in value))
    throw new Error("图形修复结果无效");
  const label = SHAPE_LABELS.find((label) => label === value.label);
  if (!label) throw new Error("图形修复类别无效");
  return { label, points: parseRecognitionPoints(value.points) };
}
