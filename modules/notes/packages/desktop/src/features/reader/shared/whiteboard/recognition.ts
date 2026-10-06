import { BOARD_COORDINATE_LIMIT, type InkPoint } from "./model";

/** 模型输出顺序与训练、ONNX 元数据固定一致；other 永远不进入几何修复。 */
const SHAPE_LABELS = [
  "line",
  "circle",
  "ellipse",
  "arc",
  "rectangle",
  "triangle",
  "arrow",
  "other",
] as const;
/** 静态图形的类别；几何坐标仍由原始向量采样拟合。 */
export type ShapeLabel = (typeof SHAPE_LABELS)[number];
/** 圆/椭圆在完整八类 softmax 中的实际概率；不能用最高分的补数伪造另一类概率。 */
export type OvalEvidence = { circle: number; ellipse: number };
/** 分类结果；缺少子类型证据时保守使用原模型类别，不启用跨子类型修复。 */
export type ShapeCandidate = { label: ShapeLabel; confidence: number; oval?: OvalEvidence };
/** 同一特征提取器的原候选与改进候选；改进候选仅在原候选无法修复时使用。 */
export type ShapePrediction = ShapeCandidate & { refinement?: ShapeCandidate };
/** 一次推理只接受一个连续笔迹，限制后台栅格化与 IPC 的输入开销。 */
export const RECOGNITION_POINT_LIMIT = 8192;
/** 停笔静止区域的屏幕半径；输入计时与拟合去抖共用，单位为CSS像素。 */
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

/** 校验后台分类结果；未知类别或非法置信度抛错，防止错误模型触发修复。 */
function parseShapeCandidate(value: unknown): ShapeCandidate {
  if (
    typeof value !== "object" ||
    value === null ||
    !("label" in value) ||
    !("confidence" in value) ||
    typeof value.confidence !== "number" ||
    !Number.isFinite(value.confidence) ||
    value.confidence < 0 ||
    value.confidence > 1
  )
    throw new Error("图形识别结果无效");
  const label = SHAPE_LABELS.find((candidate) => candidate === value.label);
  if (!label) throw new Error("图形识别类别无效");
  if ("oval" in value && value.oval !== undefined) {
    const oval = value.oval;
    if (
      (label !== "circle" && label !== "ellipse") ||
      typeof oval !== "object" ||
      oval === null ||
      !("circle" in oval) ||
      !("ellipse" in oval) ||
      typeof oval.circle !== "number" ||
      typeof oval.ellipse !== "number" ||
      !Number.isFinite(oval.circle) ||
      !Number.isFinite(oval.ellipse) ||
      oval.circle < 0 ||
      oval.ellipse < 0 ||
      oval.circle > 1 ||
      oval.ellipse > 1 ||
      oval.circle + oval.ellipse > 1 + 1e-6 ||
      Math.abs((label === "circle" ? oval.circle : oval.ellipse) - value.confidence) > 1e-6 ||
      (label === "circle" ? oval.circle < oval.ellipse : oval.ellipse < oval.circle)
    )
      throw new Error("闭合曲线子类型概率无效");
    return {
      label,
      confidence: value.confidence,
      oval: { circle: oval.circle, ellipse: oval.ellipse },
    };
  }
  return { label, confidence: value.confidence };
}

/** 校验两个独立八类输出；非法候选或递归嵌套抛错，单输出模型仍使用原契约。 */
export function parseShapePrediction(value: unknown): ShapePrediction {
  const primary = parseShapeCandidate(value);
  if (
    typeof value === "object" &&
    value !== null &&
    "refinement" in value &&
    value.refinement !== undefined
  ) {
    const refinement = value.refinement;
    if (typeof refinement !== "object" || refinement === null || "refinement" in refinement)
      throw new Error("图形改进候选无效");
    return { ...primary, refinement: parseShapeCandidate(refinement) };
  }
  return primary;
}
