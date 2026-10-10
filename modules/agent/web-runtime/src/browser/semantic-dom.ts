import type { describeElement } from "./dom.js";

/** 固定引擎只用其只读选择能力；不把脚本或原始选择器暴露给模型。 */
export interface SelectorEngine {
  parseSelector(selector: string): unknown;
  querySelectorAll(selector: unknown, root: Document | Element): Element[];
}

/** 唯一匹配后保存真实对象及原始指纹；滚动、等待或输入不能重新解释此对象。 */
export function bindSemanticDom(
  engine: SelectorEngine,
  selector: string,
  key: string,
  id: string,
  describe: typeof describeElement,
  count: boolean,
): { count: number; tag?: string } {
  const elements = engine.querySelectorAll(engine.parseSelector(selector), document);
  if (count) return { count: elements.length };
  if (elements.length !== 1 || !elements[0])
    throw new Error(`语义目标需要唯一匹配，实际为 ${elements.length}`);
  const element = elements[0];
  const state = describe(element);
  if (!state.connected) throw new Error("语义目标已经脱离文档");
  Reflect.set(window, key, {
    observation: id,
    references: new Map([["target", { element, fingerprint: state.fingerprint }]]),
  });
  return { count: 1, tag: element.tagName.toLowerCase() };
}

/** 读取固定的有界结构；安全输入值被屏蔽，不提供任意属性或 JS 执行入口。 */
export function inspectSemanticDom(element: Element): Record<string, unknown> {
  const secure = element instanceof HTMLInputElement && element.type === "password";
  const value = secure
    ? null
    : element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement
      ? element.value
      : null;
  const content = element instanceof HTMLElement ? element.innerText : (element.textContent ?? "");
  const chars = [...content];
  const attributes: Record<string, string> = {};
  for (const name of [
    "role",
    "aria-label",
    "aria-checked",
    "aria-expanded",
    "placeholder",
    "data-testid",
    "href",
    "type",
  ])
    if (element.hasAttribute(name))
      attributes[name] = (element.getAttribute(name) ?? "").slice(0, 4096);
  return {
    tag: element.tagName.toLowerCase(),
    text: chars.slice(0, 16384).join(""),
    value: typeof value === "string" ? value.slice(0, 16384) : value,
    attributes,
    checked:
      element instanceof HTMLInputElement && ["checkbox", "radio"].includes(element.type)
        ? element.checked
        : null,
    disabled: element.matches(":disabled"),
    truncated: chars.length > 16384 || (value?.length ?? 0) > 16384,
  };
}

/** 已绑定目标的读取与滚动共用原始指纹核验，禁止覆写指纹来使失效节点通过。 */
export function semanticTargetDom(
  key: string,
  id: string,
  describe: typeof describeElement,
): Element {
  const stored: unknown = Reflect.get(window, key);
  if (
    !stored ||
    typeof stored !== "object" ||
    !("observation" in stored) ||
    stored.observation !== id ||
    !("references" in stored) ||
    !(stored.references instanceof Map)
  )
    throw new Error("语义目标已经失效");
  const entry: unknown = stored.references.get("target");
  if (
    !entry ||
    typeof entry !== "object" ||
    !("element" in entry) ||
    !(entry.element instanceof Element) ||
    !("fingerprint" in entry)
  )
    throw new Error("语义目标对象无效");
  const state = describe(entry.element);
  if (!state.connected || state.fingerprint !== entry.fingerprint)
    throw new Error("语义目标身份或业务上下文已变化");
  return entry.element;
}
