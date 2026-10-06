import {
  BOARD_COORDINATE_LIMIT,
  WhiteboardHistory,
  type InkPoint,
  type WhiteboardDocument,
} from "../../shared/whiteboard/model";
import {
  DEFAULT_MIN_SCALE,
  erasedStrokes,
  inkBounds,
  insideBounds,
  toWorld,
  translateViewport,
  zoomAt,
  type BoardViewport,
  type InkBounds,
} from "../../shared/whiteboard/geometry";
import { fitShape, type ShapeFit } from "../../shared/whiteboard/fitting";
import { advancePause, preparePause, type PauseRegion } from "../../shared/whiteboard/pause";
import { InkSmoother } from "../../shared/whiteboard/smoothing";
import {
  RECOGNITION_POINT_LIMIT,
  HOLD_RADIUS_CSS_PX,
  parseShapePrediction,
  type ShapePrediction,
} from "../../shared/whiteboard/recognition";

/** 当前指针事务；原始输入与修正预览分离，请求号负责淘汰继续绘制后的结果。 */
type Gesture =
  | {
      kind: "ink";
      points: InkPoint[];
      preview: ShapeFit | null;
      smoother: InkSmoother;
      /** 计时、观测归并与结果失效共用同一个静止区域。 */
      pause: PauseRegion;
      held: boolean;
      request: number;
    }
  | { kind: "move"; start: InkPoint; dx: number; dy: number }
  | { kind: "pan"; start: InkPoint; view: BoardViewport };

function validateSample(point: InkPoint): void {
  if (
    ![point.x, point.y, point.pressure].every(Number.isFinite) ||
    point.pressure < 0 ||
    point.pressure > 1
  )
    throw new Error("白板输入包含无效坐标或压力");
}

/**
 * 单指针输入状态机：预览与文档事务分离，落笔完成才提交一次历史。
 * 坐标参数均为画布内屏幕坐标；组件负责指针捕获、定时器和键盘事件。
 */
export class WhiteboardInput {
  private readonly history: WhiteboardHistory;
  private camera: BoardViewport = { x: 0, y: 0, scale: 1 };
  private minimumScale = DEFAULT_MIN_SCALE;
  private selected = new Set<string>();
  private gesture: Gesture | null = null;
  private idleWaiters: Array<() => void> = [];

  /**
   * @param document 已读取的白板；构造时重新校验并建立不可变快照。
   * @param changed 同步画面通知；true 表示已提交内容事务，需要保存。回调应不抛错。
   * @param recognize 可选后台静态分类入口；缺失时保留原笔迹，推理失败向上传播。
   * @throws 初始文档违反格式契约时拒绝创建输入会话。
   */
  constructor(
    document: WhiteboardDocument,
    private readonly changed: (contentChanged: boolean) => void,
    private readonly recognize?: (points: readonly InkPoint[]) => Promise<ShapePrediction>,
  ) {
    this.history = new WhiteboardHistory(document);
  }

  /** 当前不可变内容；外部不能通过历史对象绕过修改通知。 */
  get document(): WhiteboardDocument {
    return this.history.document;
  }
  /** 已提交内容的递增修订号，预览和相机移动不增加修订。 */
  get revision(): number {
    return this.history.revision;
  }
  /** 当前是否存在可撤销的内容事务。 */
  get canUndo(): boolean {
    return this.history.canUndo;
  }
  /** 当前是否存在可重做的内容事务。 */
  get canRedo(): boolean {
    return this.history.canRedo;
  }

  /** 当前相机；移动相机不会修改文档或进入撤销栈。 */
  get viewport(): BoardViewport {
    return this.camera;
  }
  /** 临时笔迹，尚未进入文档；取消手势可以直接丢弃。 */
  get points(): readonly InkPoint[] {
    return this.gesture?.kind === "ink"
      ? (this.gesture.preview?.points ?? this.gesture.points)
      : [];
  }
  /** 当前实际显示的轨迹；自由笔迹保留真实笔尖，停笔修复预览优先显示。 */
  get displayPoints(): readonly InkPoint[] {
    return this.gesture?.kind === "ink"
      ? (this.gesture.preview?.points ?? this.gesture.smoother.points)
      : [];
  }
  /** 已通过分类与拟合门槛的临时预览，抬笔前仍未进入文档。 */
  get corrected(): boolean {
    return this.gesture?.kind === "ink" && this.gesture.preview !== null;
  }

  /** 规范预览的最终几何类型；模型只选择拟合族，未修复时返回 null。 */
  get correctedLabel(): ShapeFit["label"] | null {
    return this.gesture?.kind === "ink" ? (this.gesture.preview?.label ?? null) : null;
  }

  /** 卸载时丢弃未提交的手势并释放空闲等待，不触发文档修改通知。 */
  dispose(): void {
    this.gesture = null;
    this.notifyIdle();
  }

  /** 后台刷新等待真实事务结束；取消与卸载也释放等待，同步开始的新手势继续受保护。 */
  async waitForIdle(): Promise<void> {
    while (this.active) await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  private notifyIdle(): void {
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }
  /** 当前选择的稳定身份。 */
  get selection(): ReadonlySet<string> {
    return this.selected;
  }
  /** 拖动预览偏移，提交前不改原始坐标。 */
  get displacement(): { x: number; y: number } {
    return this.gesture?.kind === "move"
      ? { x: this.gesture.dx, y: this.gesture.dy }
      : { x: 0, y: 0 };
  }
  /** 当前选择范围，不包含拖动预览偏移。 */
  get selectionBounds(): InkBounds | null {
    return inkBounds(this.history.document.strokes.filter((s) => this.selected.has(s.id)));
  }
  /** 是否有尚未结束的指针事务。 */
  get active(): boolean {
    return this.gesture !== null;
  }

  private world(point: InkPoint): InkPoint {
    const p = toWorld(this.camera, point.x, point.y);
    if (Math.abs(p.x) > BOARD_COORDINATE_LIMIT || Math.abs(p.y) > BOARD_COORDINATE_LIMIT)
      throw new Error("白板坐标超出可保存范围");
    return { ...p, pressure: point.pressure };
  }

  /**
   * 开始写画、拖动选择或平移；先校验新输入，再结束此前事务。
   * @param point 有限屏幕坐标与 [0, 1] 压力。
   * @param pan 是否仅移动相机；平移不受内容坐标范围限制。
   * @param time 可选真实事件采样时刻，单位毫秒；缺失时保留原始几何，不猜测频率。
   * @throws 输入无效、内容坐标越界或此前事务无法提交时保留原状态并抛错。
   */
  begin(point: InkPoint, pan = false, time?: number): void {
    validateSample(point);
    const world = pan ? null : this.world(point);
    const smoother = world ? new InkSmoother(world, this.camera.scale, time) : null;
    this.finish();
    const bounds = this.selectionBounds;
    if (world === null) this.gesture = { kind: "pan", start: point, view: this.camera };
    else if (bounds && insideBounds(world, bounds, 6 / this.camera.scale))
      this.gesture = { kind: "move", start: world, dx: 0, dy: 0 };
    else {
      this.selected = new Set();
      this.gesture = {
        kind: "ink",
        points: [world],
        preview: null,
        smoother: smoother!,
        pause: { center: world, enclosing: world, start: 0, reset: 0 },
        held: false,
        request: 0,
      };
    }
    this.changed(false);
  }

  /**
   * 追加屏幕采样或更新拖动；无活动手势时不修改内容。
   * @param point 有限屏幕坐标与 [0, 1] 压力。
   * @param terminal 保留抬笔末点，不受移动采样阈值影响。
   * @param time 真实事件毫秒时刻；倒退或非法时间拒绝本次采样，原始输入不修改。
   * @returns 写画越过静止区域时为 true，界面据此重启停笔计时；平移、拖动或微抖返回 false。
   * @throws 非法采样或坐标越界时拒绝本次更新，保留此前有效输入。
   */
  update(point: InkPoint, terminal = false, time?: number): boolean {
    validateSample(point);
    const active = this.gesture;
    if (!active) return false;
    if (active.kind === "pan") {
      this.camera = translateViewport(
        active.view,
        point.x - active.start.x,
        point.y - active.start.y,
      );
      this.changed(false);
      return false;
    }
    const world = this.world(point);
    let restartHold = false;
    if (active.kind === "ink") {
      active.smoother.checkTime(time);
      const radius = HOLD_RADIUS_CSS_PX / this.camera.scale;
      const outside =
        Math.hypot(world.x - active.pause.center.x, world.y - active.pause.center.y) > radius;
      const last = active.points.at(-1)!;
      const distance = Math.hypot(world.x - last.x, world.y - last.y);
      if (
        terminal
          ? distance === 0 && world.pressure === last.pressure
          : distance * this.camera.scale < 0.35 && !outside
      )
        return false;
      // 越界观测即使间距很小也必须保留，静止区域索引和原始笔迹才能共享真实采样。
      active.points.push(world);
      active.smoother.push(world, time, terminal);
      const pause = advancePause(active.smoother.motion, active.pause, radius);
      if (pause.reset !== active.pause.reset) {
        active.request++;
        active.preview = null;
        active.held = false;
        restartHold = true;
      }
      active.pause = pause;
    } else {
      active.dx = world.x - active.start.x;
      active.dy = world.y - active.start.y;
    }
    this.changed(false);
    return restartHold;
  }

  /**
   * 停笔时分类当前这一笔，拟合通过才更新预览；不要求圈住已有内容。
   * @returns 是否展示了修正；抬笔、移动、取消或换文档后的迟到结果返回 false。
   * @throws 当前有效请求的推理或协议错误向上传播，原始采样始终保留。
   */
  async hold(): Promise<boolean> {
    const active = this.gesture;
    if (
      active?.kind !== "ink" ||
      !this.recognize ||
      active.held ||
      active.points.length < 2 ||
      active.points.length > RECOGNITION_POINT_LIMIT
    )
      return false;
    const xs = active.points.map((p) => p.x),
      ys = active.points.map((p) => p.y);
    if (
      Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) *
        this.camera.scale <
      16
    )
      return false;
    const observations = active.points.map((p) => ({ ...p }));
    const prepared = preparePause(
      active.smoother.snapshot(),
      active.pause,
      HOLD_RADIUS_CSS_PX / this.camera.scale,
      active.smoother.motion,
    );
    const snapshot = prepared.points;
    active.pause = prepared.pause;
    active.held = true;
    const request = ++active.request;
    try {
      const prediction = parseShapePrediction(await this.recognize(snapshot));
      if (this.gesture !== active || active.request !== request) return false;
      active.preview = fitShape(snapshot, prediction, this.camera.scale, observations);
      if (!active.preview) return false;
      this.changed(false);
      return true;
    } catch (cause) {
      if (this.gesture !== active || active.request !== request) return false;
      throw cause;
    }
  }

  /**
   * 抬笔或离开文档时结束事务；一次涂划删除、选择移动或落笔只占一次撤销。
   * @param terminal 真实抬笔事件的屏幕采样；失焦或保存门禁不提供虚构坐标。
   * @param time 抬笔事件的真实毫秒时刻；无真实事件时不补时间或坐标。
   * @throws 原始输入超出文件契约时不提交，调用方应展示错误。
   */
  finish(terminal?: InkPoint, time?: number): void {
    if (terminal) this.update(terminal, true, time);
    const active = this.gesture;
    if (!active) return;
    let edited = false;
    if (active.kind === "ink") {
      const erased = active.preview
        ? []
        : erasedStrokes(active.points, this.history.document.strokes, this.camera.scale);
      const points = active.preview?.points ?? active.smoother.points;
      const changedGeometry =
        points.length !== active.points.length ||
        points.some(
          (point, i) =>
            point.x !== active.points[i]!.x ||
            point.y !== active.points[i]!.y ||
            point.pressure !== active.points[i]!.pressure,
        );
      edited =
        erased.length > 0
          ? this.history.remove(new Set(erased))
          : this.history.add({
              id: crypto.randomUUID(),
              width: 2,
              points,
              ...(changedGeometry ? { source: active.points } : {}),
            });
    } else if (active.kind === "move")
      edited = this.history.move(this.selected, active.dx, active.dy);
    // 只有成功提交后才能清除临时输入；失败后重试仍应检查同一个事务。
    this.gesture = null;
    this.changed(edited);
    this.notifyIdle();
  }

  /** 取消临时手势或选择，正式文档和历史保持不变。 */
  cancel(): void {
    this.dispose();
    this.selected = new Set();
    this.changed(false);
  }

  /** 删除选择；快捷键和辅助设备复用同一事务入口。 */
  deleteSelection(): void {
    this.finish();
    const edited = this.history.remove(this.selected);
    this.selected = new Set();
    this.changed(edited);
  }

  /** 选择全部正式笔迹，不改变内容。 */
  selectAll(): void {
    this.finish();
    this.selected = new Set(this.history.document.strokes.map((s) => s.id));
    this.changed(false);
  }

  /** 撤销或重做前取消临时选择，避免删除或移动不存在的笔迹。 */
  applyHistory(action: "undo" | "redo"): void {
    this.finish();
    this.selected = new Set();
    this.changed(this.history[action]());
  }

  /** 以有限屏幕位移平移；手势期间忽略，数值无效或溢出时抛错且相机不变。 */
  pan(dx: number, dy: number): void {
    if (this.active) return;
    this.camera = translateViewport(this.camera, dx, dy);
    this.changed(false);
  }

  /** 按正的有限倍数围绕屏幕点缩放；手势期间忽略，非法参数抛错且相机不变。 */
  zoom(x: number, y: number, factor: number): void {
    if (this.active) return;
    this.camera = zoomAt(this.camera, x, y, factor, this.minimumScale);
    this.changed(false);
  }

  /**
   * 根据画布屏幕尺寸完整适配内容，并允许缩放回适配比例；空白板保持一比一。
   * @param width 画布宽度，单位为 CSS 像素。
   * @param height 画布高度，单位为 CSS 像素。
   * @throws 非有限尺寸抛错；不足一像素的未布局容器或活动手势不改变相机。
   */
  fit(width: number, height: number): void {
    if (![width, height].every(Number.isFinite)) throw new Error("白板视口尺寸无效");
    if (width < 1 || height < 1 || this.active) return;
    const bounds = inkBounds(this.history.document.strokes);
    if (!bounds) this.camera = { x: 0, y: 0, scale: 1 };
    else {
      const padding = Math.min(40, width / 4, height / 4);
      const scale = Math.min(
        1,
        (width - padding * 2) / bounds.width,
        (height - padding * 2) / bounds.height,
      );
      this.camera = {
        x: width / 2 - (bounds.x + bounds.width / 2) * scale,
        y: height / 2 - (bounds.y + bounds.height / 2) * scale,
        scale,
      };
    }
    this.minimumScale = Math.min(DEFAULT_MIN_SCALE, this.camera.scale);
    this.changed(false);
  }
}
