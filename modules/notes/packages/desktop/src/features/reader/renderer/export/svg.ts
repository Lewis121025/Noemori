import DOMPurify from "dompurify";

/**
 * 核验 SVG 的完整资源闭包；嵌套 data 图片继续验证，网页链接仅保留导航语义。
 * @param source 已冻结并通过 UTF-8 解码的 SVG。
 * @param checkImage 使用同一图片预算核验嵌套资源，失败向外传播。
 * @throws XML、执行内容、缺失资源、循环引用或不能离线保存的依赖。
 */
export async function validateExportSvg(
  source: string,
  checkImage: (source: string) => Promise<unknown>,
): Promise<void> {
  const parsed = new DOMParser().parseFromString(source, "image/svg+xml");
  if (parsed.querySelector("parsererror,script,foreignObject"))
    throw new Error("SVG 包含无效或不能安全保留的内容");
  const elements = Array.from(parsed.querySelectorAll("*"));
  const identities = new Map<string, Element>();
  const dependencies = new Map<Element, Set<Element>>();
  for (const element of elements) {
    if (!element.id) continue;
    if (identities.has(element.id)) throw new Error("SVG 资源标识重复");
    identities.set(element.id, element);
  }
  const reference = async (owner: Element, value: string): Promise<void> => {
    if (value.startsWith("#")) {
      const target = identities.get(decodeURIComponent(value.slice(1)));
      if (!target) throw new Error(`SVG 引用了缺失的内部资源：${value}`);
      const references = dependencies.get(owner) ?? new Set<Element>();
      references.add(target);
      dependencies.set(owner, references);
    } else if (value.startsWith("data:image/")) await checkImage(value);
    else throw new Error("SVG 依赖外部资源，无法独立导出");
  };
  const checkUrls = async (owner: Element, css: string): Promise<void> => {
    if (/@import|\\/i.test(css)) throw new Error("SVG 包含不能可靠冻结的外部或转义样式");
    for (const match of css.matchAll(/url\(\s*["']?([^)'"\s]+)/gi))
      await reference(owner, match[1] ?? "");
  };
  for (const element of elements) {
    for (const attribute of Array.from(element.attributes)) {
      if (/^on/i.test(attribute.name)) throw new Error("SVG 包含可执行事件");
      if (attribute.localName === "href" && attribute.value !== "") {
        if (element.localName === "a") {
          if (attribute.value.startsWith("#")) {
            if (!identities.has(decodeURIComponent(attribute.value.slice(1))))
              throw new Error("SVG 超链接缺少内部目标");
          } else if (!/^(?:https?:|mailto:)/i.test(attribute.value))
            throw new Error("SVG 超链接不是可移植地址");
        } else await reference(element, attribute.value);
      }
      if (attribute.name === "style" || /url\(/i.test(attribute.value))
        await checkUrls(element, attribute.value);
    }
    if (element.localName === "style") await checkUrls(element, element.textContent ?? "");
  }
  const checked = new Set<Element>();
  const active = new Set<Element>();
  const visit = (element: Element): void => {
    if (active.has(element)) throw new Error("SVG 存在循环资源引用");
    if (checked.has(element)) return;
    active.add(element);
    for (const child of Array.from(element.children)) visit(child);
    for (const target of dependencies.get(element) ?? []) visit(target);
    active.delete(element);
    checked.add(element);
  };
  visit(parsed.documentElement);
}

/** 生成的图表也先核验完整性；安全清理导致文字或无障碍说明丢失时拒绝交付。 */
export async function sanitizeExportDiagram(
  source: string,
  checkImage: (source: string) => Promise<unknown>,
): Promise<string> {
  await validateExportSvg(source, checkImage);
  const safe = DOMPurify.sanitize(source, { USE_PROFILES: { svg: true, svgFilters: true } });
  const words = (svg: string): string[] =>
    Array.from(
      new DOMParser().parseFromString(svg, "image/svg+xml").querySelectorAll("text, title, desc"),
      (element) => element.textContent ?? "",
    );
  if (!safe.includes("<svg") || JSON.stringify(words(source)) !== JSON.stringify(words(safe)))
    throw new Error("图表安全清理导致文字内容变化，无法导出");
  return safe;
}
