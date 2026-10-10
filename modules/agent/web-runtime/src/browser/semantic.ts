/** 单步语义查询；scope 通过 chain 顺序表达，禁止 CSS、脚本和按位置猜测。 */
export type SemanticQuery = {
  kind: "role" | "label" | "text" | "placeholder" | "test_id";
  value: string;
  name?: string;
  exact?: boolean;
  filter?: SemanticFilter;
};
/** 后代条件相对于候选节点求值，不能跨 frame 或引用另一页面。 */
export type SemanticFilter = {
  has_text?: string;
  has_not_text?: string;
  has?: SemanticQuery[];
  has_not?: SemanticQuery[];
  visible?: boolean;
};
/** iframe 路径的每一级必须唯一；最终 chain 在该 frame 的文档内解析。 */
export type SemanticLocator = {
  chain: SemanticQuery[];
  frames?: SemanticQuery[][];
  frame_url?: string;
};
/** 单次定位与动作绑定真实节点；只读 count 允许多个匹配，其余操作严格唯一。 */
export type SemanticAction = { action: "locator"; page: string; locator: SemanticLocator } & (
  | { operation: "click" | "hover" | "inspect" | "count" }
  | { operation: "fill"; text: string }
  | { operation: "press"; key: string }
  | { operation: "select"; values: string[]; by: "label" | "value" }
  | { operation: "check"; checked: boolean }
);

function object(value: unknown): Record<string, unknown> {
  if (!isObject(value)) throw new Error("语义查询需要对象");
  return value;
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function only(input: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(input).some((key) => !keys.includes(key)))
    throw new Error("语义查询包含未知字段");
}
function string(value: unknown, maximum = 4096, empty = false): string {
  if (typeof value !== "string" || (!empty && !value.trim()) || value.length > maximum)
    throw new Error("语义查询文字无效或超过预算");
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("语义查询布尔值无效");
  return value;
}
function chain(value: unknown, depth: number, budget: { nodes: number }): SemanticQuery[] {
  if (depth > 8 || !Array.isArray(value) || !value.length || value.length > 8)
    throw new Error("语义查询层级或链长度超过预算");
  return value.map((raw) => {
    if (++budget.nodes > 64) throw new Error("语义查询总节点数超过预算");
    const input = object(raw);
    only(input, ["kind", "value", "name", "exact", "filter"]);
    const kind = input.kind;
    if (
      kind !== "role" &&
      kind !== "label" &&
      kind !== "text" &&
      kind !== "placeholder" &&
      kind !== "test_id"
    )
      throw new Error("语义查询类型无效");
    if (input.name !== undefined && kind !== "role") throw new Error("name 只用于角色查询");
    const query: SemanticQuery = {
      kind,
      value: string(input.value),
      ...(input.name === undefined ? {} : { name: string(input.name, 4096, true) }),
      ...(input.exact === undefined ? {} : { exact: boolean(input.exact) }),
    };
    if (kind === "role" && !/^[a-z]+$/.test(query.value)) throw new Error("ARIA role 名称无效");
    if (input.filter !== undefined) {
      const filter = object(input.filter);
      only(filter, ["has_text", "has_not_text", "has", "has_not", "visible"]);
      query.filter = {
        ...(filter.has_text === undefined ? {} : { has_text: string(filter.has_text) }),
        ...(filter.has_not_text === undefined ? {} : { has_not_text: string(filter.has_not_text) }),
        ...(filter.has === undefined ? {} : { has: chain(filter.has, depth + 1, budget) }),
        ...(filter.has_not === undefined
          ? {}
          : { has_not: chain(filter.has_not, depth + 1, budget) }),
        ...(filter.visible === undefined ? {} : { visible: boolean(filter.visible) }),
      };
    }
    return query;
  });
}

/** 校验完整有界查询，非法字段、嵌套或跨 frame 过滤在派发前抛错。 */
export function parseSemanticLocator(value: unknown): SemanticLocator {
  const input = object(value);
  only(input, ["chain", "frames", "frame_url"]);
  const budget = { nodes: 0 };
  const result: SemanticLocator = { chain: chain(input.chain, 0, budget) };
  if (input.frame_url !== undefined) {
    result.frame_url = string(input.frame_url, 8192);
  }
  if (input.frames !== undefined) {
    if (!Array.isArray(input.frames) || input.frames.length > 8)
      throw new Error("iframe 路径超过预算");
    result.frames = input.frames.map((value) => chain(value, 0, budget));
  }
  return result;
}

/** 只把已校验语义查询编码为 Playwright 内置选择器；文字始终作为字符串数据转义。 */
export function semanticSelector(queries: SemanticQuery[]): string {
  return queries
    .map((query) => {
      const match = (value: string) =>
        `${JSON.stringify(value)}${query.exact === false ? "i" : "s"}`;
      let selector: string;
      switch (query.kind) {
        case "role":
          selector = `internal:role=${query.value}${query.name === undefined ? "" : `[name=${match(query.name)}]`}`;
          break;
        case "label":
          selector = `internal:label=${match(query.value)}`;
          break;
        case "text":
          selector = `internal:text=${match(query.value)}`;
          break;
        case "placeholder":
          selector = `internal:attr=[placeholder=${match(query.value)}]`;
          break;
        case "test_id":
          selector = `internal:testid=[data-testid=${JSON.stringify(query.value)}s]`;
          break;
      }
      const filter = query.filter;
      if (filter?.has_text !== undefined)
        selector += ` >> internal:has-text=${JSON.stringify(filter.has_text)}i`;
      if (filter?.has_not_text !== undefined)
        selector += ` >> internal:has-not-text=${JSON.stringify(filter.has_not_text)}i`;
      if (filter?.has !== undefined)
        selector += ` >> internal:has=${JSON.stringify(semanticSelector(filter.has))}`;
      if (filter?.has_not !== undefined)
        selector += ` >> internal:has-not=${JSON.stringify(semanticSelector(filter.has_not))}`;
      if (filter?.visible !== undefined) selector += ` >> visible=${filter.visible}`;
      return selector;
    })
    .join(" >> ");
}

/** 校验语义动作参数；未知操作与超预算文字、选项在浏览器输入前拒绝。 */
export function parseSemanticAction(input: Record<string, unknown>, page: string): SemanticAction {
  only(input, [
    "action",
    "page",
    "locator",
    "operation",
    "text",
    "key",
    "values",
    "by",
    "checked",
    "observation_mode",
  ]);
  const base = { action: "locator" as const, page, locator: parseSemanticLocator(input.locator) };
  const operation = input.operation;
  if (
    operation === "click" ||
    operation === "hover" ||
    operation === "inspect" ||
    operation === "count"
  )
    return { ...base, operation };
  if (operation === "fill") return { ...base, operation, text: string(input.text, 65536, true) };
  if (operation === "press") return { ...base, operation, key: string(input.key, 100) };
  if (operation === "check") return { ...base, operation, checked: boolean(input.checked) };
  if (operation === "select") {
    if (!Array.isArray(input.values) || input.values.length > 50)
      throw new Error("选择选项超过预算");
    if (input.by !== undefined && input.by !== "label" && input.by !== "value")
      throw new Error("选项匹配模式无效");
    return {
      ...base,
      operation,
      values: input.values.map((value) => string(value)),
      by: input.by ?? "label",
    };
  }
  throw new Error("未知语义定位动作");
}
