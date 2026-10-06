/** 已校验的世界坐标采样；压力范围为 [0, 1]，视口操作不会改写它。 */
export type InkPoint = { readonly x: number; readonly y: number; readonly pressure: number };

/** 一次落笔形成一条稳定身份的笔迹，删除和移动都以整条笔迹为单位。 */
export type InkStroke = {
  readonly id: string;
  readonly width: number;
  readonly points: readonly InkPoint[];
  /** 平滑或修复前的完整原始观测；显示、命中与导出统一使用 points。 */
  readonly source?: readonly InkPoint[];
};

/** 独立白板文件的唯一内容；视口、选择与临时修正预览不属于文档历史。 */
export type WhiteboardDocument = { readonly version: 2; readonly strokes: readonly InkStroke[] };

/** 世界坐标的有限范围，避免损坏文件或失控输入产生不可绘制的路径。 */
export const BOARD_COORDINATE_LIMIT = 10_000_000;
const MAX_POINTS = 1_000_000;
const MAX_STROKES = 100_000;

/** 判断真实库内文件名；不会把其他扩展名或链接片段误认成白板。 */
export function isWhiteboardPath(path: string): boolean {
  return path.toLowerCase().endsWith(".noemoriboard");
}

/** 返回没有共享可变数组的空白板；不访问磁盘。 */
export function emptyWhiteboard(): WhiteboardDocument {
  return { version: 2, strokes: [] };
}

function record(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => key in value)
  );
}

function numberIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function readPoints(value: unknown): readonly InkPoint[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_POINTS)
    throw new Error("白板包含无效笔迹采样");
  return Object.freeze(
    value.map((point: unknown): InkPoint => {
      if (
        !record(point, ["x", "y", "pressure"]) ||
        !numberIn(point.x, -BOARD_COORDINATE_LIMIT, BOARD_COORDINATE_LIMIT) ||
        !numberIn(point.y, -BOARD_COORDINATE_LIMIT, BOARD_COORDINATE_LIMIT) ||
        !numberIn(point.pressure, 0, 1)
      )
        throw new Error("白板包含无效坐标或压力");
      return Object.freeze({ x: point.x, y: point.y, pressure: point.pressure });
    }),
  );
}

function readStroke(value: unknown, legacy = false): InkStroke {
  if (
    !(
      record(value, ["id", "width", "points"]) ||
      (!legacy && record(value, ["id", "width", "points", "source"]))
    ) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    value.id.length > 128 ||
    !numberIn(value.width, 0.1, 100)
  )
    throw new Error("白板包含无效笔迹");
  const points = readPoints(value.points);
  const source = "source" in value ? readPoints(value.source) : undefined;
  return Object.freeze({ id: value.id, width: value.width, points, ...(source ? { source } : {}) });
}

function pointCount(stroke: InkStroke): number {
  return stroke.points.length + (stroke.source?.length ?? 0);
}

function validate(value: unknown): WhiteboardDocument {
  if (
    !record(value, ["version", "strokes"]) ||
    (value.version !== 1 && value.version !== 2) ||
    !Array.isArray(value.strokes) ||
    value.strokes.length > MAX_STROKES
  )
    throw new Error("白板格式或版本不受支持，原文件未修改");
  const ids = new Set<string>();
  let count = 0;
  const strokes = value.strokes.map((item: unknown) => {
    const stroke = readStroke(item, value.version === 1);
    count += pointCount(stroke);
    if (ids.has(stroke.id) || count > MAX_POINTS) throw new Error("白板笔迹重复或采样数量超限");
    ids.add(stroke.id);
    return stroke;
  });
  return Object.freeze({ version: 2, strokes: Object.freeze(strokes) });
}

/**
 * 严格读取白板，保留未知版本的原文件，禁止以空白内容代替解析失败。
 * @param source UTF-8 解码后的独立文件。
 * @returns 已校验且不可变的版本2笔迹；版本1无损读取，不生成或推断平滑轨迹。
 * @throws JSON、版本、字段或数值无效时抛出可展示的错误。
 */
export function parseWhiteboard(source: string): WhiteboardDocument {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("白板文件不是有效 JSON，原文件未修改");
  }
  return validate(value);
}

/**
 * 序列化已校验的完整白板；不量化坐标，避免重复保存累积几何误差。
 * @param document 来自解析器、空白板工厂或编辑事务的有效内容。
 * @returns 带末尾换行的 JSON 文本，不修改文档。
 */
export function serializeWhiteboard(document: WhiteboardDocument): string {
  return `${JSON.stringify(document)}\n`;
}

/**
 * 笔迹事务与历史；提交前先验证整组变化，预览不进入历史。
 * 快照共享不可变笔迹，移动只复制命中的笔迹；最多保留 200 次编辑。
 */
export class WhiteboardHistory {
  private current: WhiteboardDocument;
  private past: WhiteboardDocument[] = [];
  private future: WhiteboardDocument[] = [];
  private generation = 0;

  /**
   * @param document 初始白板，校验后复制为不可变快照。
   * @throws 版本、笔迹身份或采样数据违反文件契约时拒绝创建会话。
   */
  constructor(document: WhiteboardDocument) {
    this.current = validate(document);
  }
  /** 当前不可变内容，仅能通过事务方法修改。 */
  get document(): WhiteboardDocument {
    return this.current;
  }
  /** 每次提交、撤销或重做递增，供保存版本核对。 */
  get revision(): number {
    return this.generation;
  }
  /** 是否存在可撤销的内容编辑。 */
  get canUndo(): boolean {
    return this.past.length > 0;
  }
  /** 新编辑会清除旧的重做分支。 */
  get canRedo(): boolean {
    return this.future.length > 0;
  }

  private commit(strokes: readonly InkStroke[]): boolean {
    if (
      strokes.length === this.current.strokes.length &&
      strokes.every((stroke, i) => stroke === this.current.strokes[i])
    )
      return false;
    if (strokes.length > MAX_STROKES || strokes.reduce((n, s) => n + pointCount(s), 0) > MAX_POINTS)
      throw new Error("白板采样数量已达上限，请新建另一张白板");
    this.past.push(this.current);
    if (this.past.length > 200) this.past.shift();
    this.future = [];
    this.current = Object.freeze({ version: 2, strokes: Object.freeze(strokes) });
    this.generation += 1;
    return true;
  }

  /**
   * 添加完整的一次落笔。
   * @param stroke 具有未占用身份的世界坐标笔迹。
   * @returns 成功提交返回 true。
   * @throws 身份冲突、数值无效或容量超限时拒绝整次事务，文档与历史不变。
   */
  add(stroke: InkStroke): boolean {
    if (this.current.strokes.some((item) => item.id === stroke.id))
      throw new Error("白板笔迹身份重复");
    return this.commit([...this.current.strokes, readStroke(stroke)]);
  }

  /** 删除 ids 指定的笔迹；实际删除返回 true，空集合或失效身份返回 false 且不产生历史。 */
  remove(ids: ReadonlySet<string>): boolean {
    return this.commit(this.current.strokes.filter((stroke) => !ids.has(stroke.id)));
  }

  /**
   * 整组平移，保持压力和身份。
   * @param ids 待移动的笔迹身份集合；失效身份不参与修改。
   * @param dx 世界坐标横向位移。
   * @param dy 世界坐标纵向位移。
   * @returns 实际产生内容变化返回 true，零位移或没有命中返回 false。
   * @throws 位移非有限或任意目标坐标越界时拒绝整次事务，文档与历史不变。
   */
  move(ids: ReadonlySet<string>, dx: number, dy: number): boolean {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new Error("白板移动量无效");
    if (dx === 0 && dy === 0) return false;
    return this.commit(
      this.current.strokes.map((stroke) =>
        ids.has(stroke.id)
          ? readStroke({
              ...stroke,
              points: stroke.points.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy })),
              ...(stroke.source
                ? { source: stroke.source.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy })) }
                : {}),
            })
          : stroke,
      ),
    );
  }

  /** 撤销整个手势；没有历史时返回 false。 */
  undo(): boolean {
    const previous = this.past.pop();
    if (!previous) return false;
    this.future.push(this.current);
    this.current = previous;
    this.generation += 1;
    return true;
  }

  /** 重做整个手势；没有历史时返回 false。 */
  redo(): boolean {
    const next = this.future.pop();
    if (!next) return false;
    this.past.push(this.current);
    this.current = next;
    this.generation += 1;
    return true;
  }
}
