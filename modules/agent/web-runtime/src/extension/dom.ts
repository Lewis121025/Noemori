import type { describeElement } from "../browser/dom.js";

/** 在隔离世界采集真实节点，引用保持节点身份而非位置编号。 */
export function observeDom(
  describe: typeof describeElement,
  key: string,
  id: string,
): {
  title: string;
  url: string;
  text: string;
  elements: { ref: string; description: string }[];
  viewport: { width: number; height: number };
  truncated: boolean;
  layout: string;
} {
  const references = new Map<string, { element: Element; fingerprint: string }>();
  const elements: { ref: string; description: string }[] = [];
  const roots: (Document | ShadowRoot)[] = [document];
  const boxes: unknown[] = [];
  let visited = 0;
  let truncated = false;
  for (let index = 0; index < roots.length; index++) {
    const root = roots[index];
    if (!root) break;
    for (const element of root.querySelectorAll("*")) {
      if (++visited > 50000) {
        truncated = true;
        break;
      }
      if (element.shadowRoot) roots.push(element.shadowRoot);
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (
        rect.width === 0 ||
        rect.height === 0 ||
        style.visibility === "hidden" ||
        style.display === "none"
      )
        continue;
      if (rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth)
        boxes.push([element.tagName, rect.x, rect.y, rect.width, rect.height, style.zIndex]);
      if (!element.matches("a,button,input,textarea,select,summary,[role],[contenteditable],label"))
        continue;
      const value = describe(element);
      if (!value.connected || !value.inViewport) continue;
      if (elements.length >= 250) {
        truncated = true;
        continue;
      }
      const ref = `e${elements.length}`;
      references.set(ref, { element, fingerprint: value.fingerprint });
      elements.push({ ref, description: value.description });
    }
    if (visited > 50000) break;
  }
  const body = document.body?.innerText ?? "";
  const text = [...body].slice(0, 24000).join("");
  const layout = JSON.stringify([innerWidth, innerHeight, scrollX, scrollY, boxes]);
  Reflect.set(window, key, { observation: id, references, layout });
  return {
    title: document.title,
    url: location.href,
    text,
    elements,
    viewport: { width: innerWidth, height: innerHeight },
    truncated: truncated || text.length < body.length,
    layout,
  };
}

/** 核验节点身份、语义和遮挡后读取操作位置；不会重新寻找相似节点。 */
export function inspectDom(
  describe: typeof describeElement,
  key: string,
  observation: string,
  ref: string,
): {
  x: number;
  y: number;
  tag: string;
  type: string;
  checked: boolean;
  download: string | null;
  href: string | null;
} {
  const stored: unknown = Reflect.get(window, key);
  if (
    typeof stored !== "object" ||
    stored === null ||
    !("observation" in stored) ||
    stored.observation !== observation ||
    !("references" in stored) ||
    !(stored.references instanceof Map)
  )
    throw new Error("观察失效，请重新 observe");
  const entry: unknown = stored.references.get(ref);
  if (
    typeof entry !== "object" ||
    entry === null ||
    !("element" in entry) ||
    !(entry.element instanceof Element) ||
    !("fingerprint" in entry) ||
    typeof entry.fingerprint !== "string"
  )
    throw new Error("控件引用不属于此观察");
  const element = entry.element;
  const description = describe(element);
  if (
    !description.connected ||
    !description.inViewport ||
    description.fingerprint !== entry.fingerprint
  )
    throw new Error("控件脱离文档、滚出视口或语义变化，请重新观察");
  if (
    (element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLButtonElement ||
      element instanceof HTMLSelectElement) &&
    element.disabled
  )
    throw new Error("控件已禁用");
  const box = element.getBoundingClientRect();
  const x = Math.max(0, Math.min(innerWidth - 1, box.x + box.width / 2));
  const y = Math.max(0, Math.min(innerHeight - 1, box.y + box.height / 2));
  let hit = document.elementFromPoint(x, y);
  while (hit?.shadowRoot) {
    const nested = hit.shadowRoot.elementFromPoint(x, y);
    if (!nested || nested === hit) break;
    hit = nested;
  }
  if (!hit || (hit !== element && !element.contains(hit)))
    throw new Error("控件被遮挡，拒绝点击其他对象");
  return {
    x,
    y,
    tag: element.tagName.toLowerCase(),
    type: element.getAttribute("type") || "",
    checked: element instanceof HTMLInputElement ? element.checked : false,
    download: element.getAttribute("download"),
    href: element instanceof HTMLAnchorElement ? element.href : null,
  };
}

/** 读取同一节点并执行非坐标表单操作；调用方先核验语义且只在隔离世界运行。 */
export function controlDom(
  inspect: typeof inspectDom,
  describe: typeof describeElement,
  key: string,
  observation: string,
  ref: string,
  action: string,
  values: unknown,
): void {
  inspect(describe, key, observation, ref);
  const stored: unknown = Reflect.get(window, key);
  if (
    typeof stored !== "object" ||
    stored === null ||
    !("observation" in stored) ||
    stored.observation !== observation ||
    !("references" in stored) ||
    !(stored.references instanceof Map)
  )
    throw new Error("观察失效");
  const entry: unknown = stored.references.get(ref);
  if (
    typeof entry !== "object" ||
    entry === null ||
    !("element" in entry) ||
    !(entry.element instanceof HTMLElement)
  )
    throw new Error("控件引用无效");
  const element = entry.element;
  if (action === "focus") {
    element.focus();
    return;
  }
  if (action === "select") {
    if (
      !(element instanceof HTMLSelectElement) ||
      typeof values !== "object" ||
      values === null ||
      !("values" in values) ||
      !Array.isArray(values.values) ||
      !values.values.every((v: unknown) => typeof v === "string") ||
      !("by" in values)
    )
      throw new Error("选择输入无效");
    const wanted = values.values;
    const options = [...element.options].filter((option) =>
      wanted.includes(values.by === "label" ? option.label : option.value),
    );
    if (options.length !== wanted.length || (!element.multiple && options.length > 1))
      throw new Error("选项不存在、重复或不支持多选");
    for (const option of element.options) option.selected = options.includes(option);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }
  if (action === "fill") {
    if (typeof values !== "string") throw new Error("填写输入无效");
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      if (element.readOnly) throw new Error("控件只读");
      const prototype =
        element instanceof HTMLInputElement
          ? HTMLInputElement.prototype
          : HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (!setter) throw new Error("控件没有原生值写入器");
      setter.call(element, values);
    } else if (element.isContentEditable) element.textContent = values;
    else throw new Error("控件不可填写");
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }
  throw new Error("不支持的表单操作");
}

/** 在所有开放 Shadow DOM 内查找唯一文字；歧义时拒绝滚动并要求更明确的目标。 */
export function findDom(text: string, exact: boolean, scroll: boolean): boolean {
  const roots: (Document | ShadowRoot)[] = [document];
  const candidates: Element[] = [];
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  let visited = 0;
  for (let index = 0; index < roots.length; index++) {
    const root = roots[index];
    if (!root) break;
    for (const element of root.querySelectorAll("*")) {
      if (++visited > 50000) throw new Error("文字查找超过节点预算");
      if (element.shadowRoot) roots.push(element.shadowRoot);
      const value = normalize(element.textContent || "");
      const style = getComputedStyle(element);
      if (
        (exact ? value === normalize(text) : value.includes(normalize(text))) &&
        element.getBoundingClientRect().height > 0 &&
        style.visibility !== "hidden" &&
        style.display !== "none"
      )
        candidates.push(element);
    }
  }
  const leaves = candidates.filter(
    (element) => !candidates.some((other) => other !== element && element.contains(other)),
  );
  if (!leaves.length) return false;
  if (leaves.length !== 1) throw new Error("文字命中多个控件，请提供唯一目标");
  if (scroll) leaves[0]?.scrollIntoView({ block: "center", inline: "center" });
  return true;
}

/** 把宿主固定字节构造成页面文件；参数不包含可供网页读取的本地目录。 */
export function uploadDom(
  input: Element,
  files: { name: string; mime_type: string; data: string }[],
): void {
  if (
    !(input instanceof HTMLInputElement) ||
    input.type !== "file" ||
    !input.isConnected ||
    input.disabled
  )
    throw new Error("目标不再是有效文件输入");
  if (!input.multiple && files.length > 1) throw new Error("文件输入不支持多选");
  const transfer = new DataTransfer();
  for (const file of files) {
    const bytes = Uint8Array.from(atob(file.data), (character) => character.charCodeAt(0));
    transfer.items.add(new File([bytes], file.name, { type: file.mime_type }));
  }
  input.files = transfer.files;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

/** 返回当前观察的文件输入真实对象，只供 SDK 内部的 Runtime 调用持有。 */
export function fileInputDom(key: string, observation: string, ref: string): Element {
  const stored: unknown = Reflect.get(window, key);
  if (
    typeof stored !== "object" ||
    stored === null ||
    !("observation" in stored) ||
    stored.observation !== observation ||
    !("references" in stored) ||
    !(stored.references instanceof Map)
  )
    throw new Error("观察失效");
  const entry: unknown = stored.references.get(ref);
  if (
    typeof entry !== "object" ||
    entry === null ||
    !("element" in entry) ||
    !(entry.element instanceof HTMLInputElement) ||
    entry.element.type !== "file"
  )
    throw new Error("引用不是文件输入");
  return entry.element;
}

/** 正文按 Unicode 字符分页，返回实际总长度，避免截断之后无法继续读取。 */
export function readDom(offset: number): {
  text: string;
  offset: number;
  next_offset: number | null;
  total_chars: number;
} {
  const sections = [document.body?.innerText || ""];
  const roots: (Document | ShadowRoot)[] = [document];
  let count = 0;
  for (let index = 0; index < roots.length; index++) {
    const root = roots[index];
    if (!root) break;
    for (const element of root.querySelectorAll("*")) {
      if (++count > 50000) throw new Error("正文读取超过节点预算");
      if (element.shadowRoot) {
        roots.push(element.shadowRoot);
        sections.push(
          [...element.shadowRoot.children]
            .filter((child): child is HTMLElement => child instanceof HTMLElement)
            .map((child) => child.innerText)
            .join("\n"),
        );
      }
    }
  }
  const chars = [...sections.join("\n")];
  const text = chars.slice(offset, offset + 24000).join("");
  return {
    text,
    offset,
    next_offset: offset + 24000 < chars.length ? offset + 24000 : null,
    total_chars: chars.length,
  };
}
