/** 描述同一真实 DOM 节点的角色、语义指纹和可见状态；密码不读取值。
 * @param element 页面中的真实节点。
 * @returns 有界描述与完整的有界语义指纹；已脱离文档的节点仍明确标记 disconnected。
 * @throws 语义内容超过预算时拒绝生成可操作引用，避免截断掩盖业务记录变化。
 */
// 该函数在页面上下文内执行，必须自包含；密码字段只暴露类型，不读取其值。
export function describeElement(element: Element): {
  connected: boolean;
  inViewport: boolean;
  fingerprint: string;
  description: string;
} {
  const tag = element.tagName.toLowerCase();
  const type = element.getAttribute("type") || "";
  const role = element.getAttribute("role") || tag;
  const labels =
    "labels" in element && element.labels instanceof NodeList
      ? [...element.labels].map((label) => label.textContent || "").join(" ")
      : "";
  const labelled = (element.getAttribute("aria-labelledby") || "")
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => element.ownerDocument.getElementById(id)?.textContent || "")
    .join(" ");
  const name =
    element.getAttribute("aria-label") ||
    labelled ||
    labels ||
    element.getAttribute("placeholder") ||
    element.textContent ||
    element.getAttribute("title") ||
    "";
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim().slice(0, 400);
  const context = element.closest('tr,[role="row"],li')?.textContent || "";
  const href = element.getAttribute("href") || "";
  const semantic = (value: string): string => {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (normalized.length > 8192) throw new Error("控件语义超过观察预算，不能生成可靠操作引用");
    return normalized;
  };
  const fingerprint = JSON.stringify([
    tag,
    type,
    role,
    semantic(name),
    semantic(href),
    semantic(context),
  ]);
  const state = ["disabled", "checked", "selected", "aria-expanded", "aria-checked"].flatMap(
    (key) => (element.hasAttribute(key) ? [`${key}=${element.getAttribute(key)}`] : []),
  );
  const value =
    type !== "password" && tag !== "input" && tag !== "textarea"
      ? ""
      : type === "password"
        ? " [password]"
        : "value" in element && typeof element.value === "string"
          ? ` value=${JSON.stringify(element.value.slice(0, 300))}`
          : "";
  const box = element.getBoundingClientRect();
  const view = element.ownerDocument.defaultView;
  const inViewport = Boolean(
    view &&
    box.bottom > 0 &&
    box.right > 0 &&
    box.top < view.innerHeight &&
    box.left < view.innerWidth,
  );
  return {
    connected: element.isConnected,
    inViewport,
    fingerprint,
    description: `${role}${type ? `(${type})` : ""} ${JSON.stringify(normalize(name))}${value}${href ? ` href=${href.slice(0, 500)}` : ""}${state.length ? ` [${state.join(", ")}]` : ""}${context ? ` context=${JSON.stringify(normalize(context))}` : ""}`,
  };
}

/** 在每个 frame 采集可见布局与操作语义，开放 Shadow DOM 一并核验。
 * @returns 可序列化布局签名；像素动画不改变控件定位契约。
 * @throws 超过节点或语义预算时拒绝旧截图定位。
 */
export function layoutSignature(): unknown[] {
  const geometry: unknown[] = [innerWidth, innerHeight, scrollX, scrollY];
  const roots: (Document | ShadowRoot)[] = [document];
  let count = 0;
  for (const root of roots) {
    for (const element of root.querySelectorAll("*")) {
      if (++count > 50000) throw new Error("截图布局超过节点预算");
      if (element.shadowRoot) roots.push(element.shadowRoot);
      const box = element.getBoundingClientRect();
      if (
        box.width === 0 ||
        box.height === 0 ||
        box.bottom <= 0 ||
        box.right <= 0 ||
        box.top >= innerHeight ||
        box.left >= innerWidth
      )
        continue;
      const interactive = element.matches(
        'a,button,input,select,textarea,[role],[onclick],[contenteditable="true"]',
      );
      const style = getComputedStyle(element);
      const name = interactive ? element.textContent || "" : "";
      const context = interactive ? element.closest('tr,[role="row"],li')?.textContent || "" : "";
      if (name.length > 8192 || context.length > 8192) throw new Error("截图语义超过观察预算");
      geometry.push([
        element.tagName,
        ...[box.x, box.y, box.width, box.height].map((value) => Math.round(value * 10)),
        style.visibility,
        style.opacity,
        style.pointerEvents,
        style.zIndex,
        style.clipPath,
        element.getAttribute("aria-label"),
        element.getAttribute("role"),
        element.getAttribute("href"),
        element.getAttribute("disabled"),
        element.getAttribute("aria-checked"),
        name,
        context,
      ]);
    }
  }
  return geometry;
}
