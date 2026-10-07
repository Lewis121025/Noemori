import { BOARD_COORDINATE_LIMIT, type InkReplacement, type InkPoint } from "./model";

/** 由轨迹结构与几何拟合产生的类型；规则图形和保形曲线共用返回契约。 */
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
  "curve",
  "rounded-rectangle",
  "capsule",
  "elliptical-arc",
  "parabola",
  "hyperbola",
  "sine",
  "semicircle",
  "sector",
  "ring",
  "wireframe",
  "cylinder",
  "rounded-polygon",
  "heart",
  "cloud",
] as const;
/** 规范几何的类别，无法修复时使用null，不伪造未知类或置信分数。 */
export type ShapeLabel = (typeof SHAPE_LABELS)[number];
/** 已通过完整观测校验的规范轮廓；持久化继续使用既有点列格式。 */
export type ShapeFit = {
  label: ShapeLabel;
  points: InkPoint[];
  replacements?: readonly InkReplacement[];
};
/** 只读邻近笔迹，原始观测不得被先前修复结果覆盖。 */
export type RepairContext = {
  readonly id: string;
  readonly points: readonly InkPoint[];
  readonly observations: readonly InkPoint[];
};
/** 一次停笔请求的输入契约；静态轨迹与原始观测使用同一世界坐标。 */
export type ShapeRepairRequest = {
  points: readonly InkPoint[];
  observations: readonly InkPoint[];
  scale: number;
  context?: readonly RepairContext[];
};
/** 后台几何计算接口；拒绝返回null，运行或协议错误通过Promise拒绝。 */
export type ShapeRepair = (request: ShapeRepairRequest) => Promise<ShapeFit | null>;
/** 有界输入，防止后台计算或IPC被无上限点列占用。 */
export const RECOGNITION_POINT_LIMIT = 8192;
/** 每次仅检查最近16条邻近笔迹，并限制全部静态点与观测总量。 */
export const REPAIR_CONTEXT_LIMIT = 16;
export const REPAIR_TOTAL_POINT_LIMIT = 65536;

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
  const context = "context" in value ? parseContext(value.context) : undefined;
  const points = parseRecognitionPoints(value.points),
    observations = parseRecognitionPoints(value.observations);
  if (
    points.length +
      observations.length +
      (context?.reduce((sum, item) => sum + item.points.length + item.observations.length, 0) ??
        0) >
    REPAIR_TOTAL_POINT_LIMIT
  )
    throw new Error("图形修复上下文采样超限");
  return {
    points,
    observations,
    scale: value.scale,
    ...(context ? { context } : {}),
  };
}

function validIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}
function parseContext(value: unknown): RepairContext[] {
  if (!Array.isArray(value) || value.length > REPAIR_CONTEXT_LIMIT)
    throw new Error("图形修复上下文无效");
  const ids = new Set<string>();
  return value.map((item: unknown) => {
    if (
      typeof item !== "object" ||
      item === null ||
      !("id" in item) ||
      !("points" in item) ||
      !("observations" in item) ||
      !validIdentity(item.id) ||
      ids.has(item.id)
    )
      throw new Error("图形修复上下文身份无效");
    ids.add(item.id);
    return {
      id: item.id,
      points: parseRecognitionPoints(item.points),
      observations: parseRecognitionPoints(item.observations),
    };
  });
}
function parseReplacements(value: unknown, request?: ShapeRepairRequest): InkReplacement[] {
  if (!Array.isArray(value) || value.length > REPAIR_CONTEXT_LIMIT)
    throw new Error("图形修复联动结果无效");
  const ids = new Set<string>();
  return value.map((item: unknown) => {
    if (
      typeof item !== "object" ||
      item === null ||
      !("id" in item) ||
      !("points" in item) ||
      !validIdentity(item.id) ||
      ids.has(item.id) ||
      (request && !request.context?.some((stroke) => stroke.id === item.id))
    )
      throw new Error("图形修复联动身份无效");
    ids.add(item.id);
    return { id: item.id, points: parseRecognitionPoints(item.points) };
  });
}

/**
 * 校验返回的规范几何与联动身份，不隐藏跨进程协议错误。
 * @param value 未信任的返回值或明确拒绝的null。
 * @param request 可选原请求，提供时每个替换身份必须在其上下文中。
 * @returns 有限规范几何与替换点列的独立副本，或null。
 * @throws 未知类型、数量超限、非法采样或跨请求替换身份时抛错。
 */
export function parseShapeFit(value: unknown, request?: ShapeRepairRequest): ShapeFit | null {
  if (value === null) return null;
  if (typeof value !== "object" || value === null || !("label" in value) || !("points" in value))
    throw new Error("图形修复结果无效");
  const label = SHAPE_LABELS.find((label) => label === value.label);
  if (!label) throw new Error("图形修复类别无效");
  const replacements =
    "replacements" in value ? parseReplacements(value.replacements, request) : undefined;
  const points = parseRecognitionPoints(value.points);
  if (
    points.length + (replacements?.reduce((sum, item) => sum + item.points.length, 0) ?? 0) >
    REPAIR_TOTAL_POINT_LIMIT
  )
    throw new Error("图形修复返回采样超限");
  return { label, points, ...(replacements ? { replacements } : {}) };
}
