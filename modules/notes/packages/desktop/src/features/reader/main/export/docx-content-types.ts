import { posix } from "node:path";
import { XMLParser } from "fast-xml-parser";

const wordType = "application/vnd.openxmlformats-officedocument.wordprocessingml.";
const relationshipType = "application/vnd.openxmlformats-package.relationships+xml";

/**
 * 独立核对 OPC 内容类型表；合法 XML 仍可能把正文声明为普通 XML，导致阅读器无法识别。
 * @param xml 已通过语法与命名空间检查的内容类型部件。
 * @param names 已通过 ZIP 路径检查的全部部件名。
 * @throws 声明重复、路径无效、类型缺失或必需部件类型错误时阻止发布。
 */
export function validateDocxContentTypes(xml: string, names: ReadonlySet<string>): void {
  const parsed: unknown = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@",
    parseTagValue: false,
    parseAttributeValue: false,
    isArray: (name) => name === "Default" || name === "Override",
  }).parse(xml);
  if (!record(parsed) || !record(parsed.Types)) throw new Error("DOCX 内容类型表无效");
  const defaults = new Map<string, string>();
  const overrides = new Map<string, string>();
  for (const kind of ["Default", "Override"] as const) {
    const declarations = parsed.Types[kind] ?? [];
    if (!Array.isArray(declarations)) throw new Error("DOCX 内容类型声明无效");
    for (const declaration of declarations) {
      if (
        !record(declaration) ||
        typeof declaration["@ContentType"] !== "string" ||
        !/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(declaration["@ContentType"])
      )
        throw new Error("DOCX 内容类型声明无效");
      const type = declaration["@ContentType"];
      if (kind === "Default") {
        const extension = declaration["@Extension"];
        if (typeof extension !== "string" || !/^[a-z0-9]+$/i.test(extension))
          throw new Error("DOCX 默认内容类型扩展名无效");
        const key = extension.toLowerCase();
        if (defaults.has(key)) throw new Error("DOCX 默认内容类型重复");
        defaults.set(key, type);
      } else {
        const name = declaration["@PartName"];
        if (typeof name !== "string" || !name.startsWith("/"))
          throw new Error("DOCX 内容类型部件路径无效");
        const path = decodeURIComponent(name.slice(1));
        if (!names.has(path) || path.endsWith("/") || overrides.has(path))
          throw new Error("DOCX 内容类型部件缺失或重复");
        overrides.set(path, type);
      }
    }
  }
  const required: Record<string, string> = {
    "word/document.xml": `${wordType}document.main+xml`,
    "word/styles.xml": `${wordType}styles+xml`,
    "word/numbering.xml": `${wordType}numbering+xml`,
    "word/footnotes.xml": `${wordType}footnotes+xml`,
    "word/endnotes.xml": `${wordType}endnotes+xml`,
    "word/settings.xml": `${wordType}settings+xml`,
    "word/fontTable.xml": `${wordType}fontTable+xml`,
    "word/webSettings.xml": `${wordType}webSettings+xml`,
  };
  for (const name of names) {
    if (name === "[Content_Types].xml" || name.endsWith("/")) continue;
    // OPC 根关系名为 .rels；它的扩展名也是 rels，不采用隐藏文件的 extname 语义。
    const extension = /\.([^.]+)$/.exec(posix.basename(name))?.[1]?.toLowerCase() ?? "";
    const type = overrides.get(name) ?? defaults.get(extension);
    const expected = name.endsWith(".rels") ? relationshipType : required[name];
    if (!type || (expected && type !== expected))
      throw new Error(`DOCX 部件内容类型缺失或错误：${name}`);
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
