import { XMLValidator, XMLParser } from "fast-xml-parser";
import { posix } from "node:path";
import type { FormulaExpectation } from "./math";
import { equationSignature } from "./equation-semantics";
import { errorText, ExportFailure } from "./errors";
import { readDocxPackage } from "./docx-package";
import { validateDocxContentTypes } from "./docx-content-types";

/** 原生公式同时保留数学结构和行内／陈列位置，二者都要与源记录一致。 */
type WordEquation = { xml: string; display: boolean };

/** 独立解包校验部件、媒体字节和公式语义；取消或任何不完整内容阻止整批提交。 */
export async function validateDocx(
  bytes: Uint8Array,
  formulas: number,
  expectedMath: readonly FormulaExpectation[] = [],
  expectedMedia?: ReadonlySet<string>,
  signal?: AbortSignal,
): Promise<void> {
  const { entries, names, media } = await readDocxPackage(bytes, signal);
  if (
    expectedMedia &&
    (media.size !== expectedMedia.size || [...media].some((hash) => !expectedMedia.has(hash)))
  )
    throw new Error("DOCX 媒体字节与冻结资源不一致");
  for (const name of ["[Content_Types].xml", "_rels/.rels", "word/document.xml", "word/styles.xml"])
    if (!entries[name]) throw new Error(`DOCX 缺少必需部件：${name}`);
  let actual = 0;
  const positions = new Map<number, WordEquation>();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const [name, data] of Object.entries(entries)) {
    signal?.throwIfAborted();
    const xml = decoder.decode(data);
    if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true)
      throw new Error(`DOCX XML 无效：${name}`);
    validatePartStructure(xml, name);
    if (name.startsWith("word/")) {
      actual += [...xml.matchAll(/<m:oMath(?:\s|>)/g)].length;
      if (expectedMath.length) collectEquationPositions(xml, positions);
    }
  }
  if (actual !== formulas)
    throw new Error(`DOCX 原生公式数量不一致：应有 ${formulas}，实际 ${actual}`);
  if (expectedMath.length) {
    if (positions.size !== formulas || expectedMath.length !== formulas)
      throw new Error("DOCX 原生公式来源标记不完整");
    validateEquationContent(
      expectedMath.map((_formula, index) => {
        const equation = positions.get(index + 1);
        if (equation === undefined) throw new Error("DOCX 原生公式缺少来源标记");
        return equation;
      }),
      expectedMath,
    );
  }
  validateDocxContentTypes(decoder.decode(entries["[Content_Types].xml"]), names);
  validateRelationships(entries, names, decoder);
}

/** 校验实际命名空间和正文根，合法 XML 文本不等于 Word 可以识别的 OOXML 部件。 */
function validatePartStructure(xml: string, path: string): void {
  const parsed: unknown = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@",
    parseTagValue: false,
    parseAttributeValue: false,
  }).parse(xml);
  if (!record(parsed)) throw new Error(`DOCX 部件根无效：${path}`);
  const roots = Object.keys(parsed).filter((name) => !name.startsWith("?") && name !== "#text");
  if (roots.length !== 1) throw new Error(`DOCX 部件根不唯一：${path}`);
  const required: Record<string, string> = {
    "word/document.xml": "w:document",
    "word/styles.xml": "w:styles",
    "word/numbering.xml": "w:numbering",
    "word/settings.xml": "w:settings",
    "word/fontTable.xml": "w:fonts",
    "word/webSettings.xml": "w:webSettings",
    "word/footnotes.xml": "w:footnotes",
    "word/endnotes.xml": "w:endnotes",
  };
  const rootName = roots[0] ?? "";
  const rootValue = parsed[rootName];
  const wordNamespace = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  if (
    required[path] &&
    (rootName.split(":").at(-1) !== required[path]?.split(":").at(-1) ||
      !record(rootValue) ||
      rootValue[rootName.includes(":") ? `@xmlns:${rootName.split(":")[0]}` : "@xmlns"] !==
        wordNamespace)
  )
    throw new Error(`DOCX 部件类型或命名空间无效：${path}`);
  if (
    path === "word/document.xml" &&
    (!record(parsed["w:document"]) || !("w:body" in parsed["w:document"]))
  )
    throw new Error("DOCX 缺少正文结构");
  if (
    path.endsWith(".rels") &&
    (!record(parsed.Relationships) ||
      parsed.Relationships["@xmlns"] !==
        "http://schemas.openxmlformats.org/package/2006/relationships")
  )
    throw new Error(`DOCX 关系命名空间无效：${path}`);
  if (
    path === "[Content_Types].xml" &&
    (!record(parsed.Types) ||
      parsed.Types["@xmlns"] !== "http://schemas.openxmlformats.org/package/2006/content-types")
  )
    throw new Error("DOCX 内容类型命名空间无效");
  const namespaces: Record<string, string> = {
    w: "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    m: "http://schemas.openxmlformats.org/officeDocument/2006/math",
    r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    a: "http://schemas.openxmlformats.org/drawingml/2006/main",
    wp: "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
    pic: "http://schemas.openxmlformats.org/drawingml/2006/picture",
  };
  const visit = (name: string, value: unknown, inherited: ReadonlyMap<string, string>): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(name, item, inherited);
      return;
    }
    let declarations: Map<string, string> | undefined;
    if (record(value))
      for (const [attribute, uri] of Object.entries(value)) {
        if (!attribute.startsWith("@xmlns:")) continue;
        if (typeof uri !== "string") throw new Error("DOCX 命名空间声明无效");
        declarations ??= new Map(inherited);
        declarations.set(attribute.slice(7), uri);
      }
    const context = declarations ?? inherited;
    const prefix = name.split(":")[0] ?? "";
    if (name.includes(":") && namespaces[prefix] && context.get(prefix) !== namespaces[prefix])
      throw new Error(`DOCX 使用错误的命名空间：${name}`);
    if (record(value))
      for (const [child, item] of Object.entries(value)) {
        if (child.startsWith("@") || child === "#text") continue;
        visit(child, item, context);
      }
  };
  for (const root of roots) visit(root, parsed[root], new Map());
}

/** 关系指向真实部件，正文使用的关系 ID 必须唯一存在，不能留下断开的图片。 */
function validateRelationships(
  entries: Record<string, Uint8Array>,
  names: ReadonlySet<string>,
  decoder: TextDecoder,
): void {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    isArray: (tag) => tag === "Relationship",
  });
  for (const [path, bytes] of Object.entries(entries)) {
    if (!path.endsWith(".rels")) continue;
    const data: unknown = parser.parse(decoder.decode(bytes));
    if (!record(data) || !record(data.Relationships)) throw new Error(`DOCX 关系部件无效：${path}`);
    const relationships = data.Relationships.Relationship ?? [];
    if (!Array.isArray(relationships)) throw new Error(`DOCX 关系列表无效：${path}`);
    const ids = new Set<string>();
    let mainDocuments = 0;
    const directory = posix.dirname(posix.dirname(path));
    for (const relation of relationships) {
      if (
        !record(relation) ||
        typeof relation.Id !== "string" ||
        typeof relation.Target !== "string" ||
        typeof relation.Type !== "string" ||
        ids.has(relation.Id)
      )
        throw new Error(`DOCX 关系身份无效：${path}`);
      ids.add(relation.Id);
      const target = decodeURIComponent(relation.Target.split("#", 1)[0] ?? "");
      if (relation.TargetMode === "External") {
        if (
          !relation.Type.endsWith("/hyperlink") ||
          /^(?:file:|\/|[a-z]:[\\/])/i.test(target) ||
          /^noemori-[a-z-]+:/i.test(target)
        )
          throw new Error("DOCX 保留了无法离线使用的外部资源关系");
      } else {
        const resource = posix.normalize(
          target.startsWith("/") ? target.slice(1) : posix.join(directory, target),
        );
        if (!names.has(resource)) throw new Error(`DOCX 关系缺少目标部件：${resource}`);
        if (
          path === "_rels/.rels" &&
          relation.Type ===
            "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"
        ) {
          if (resource !== "word/document.xml") throw new Error("DOCX 主文档入口未指向正文");
          mainDocuments++;
        }
      }
    }
    if (path === "_rels/.rels") {
      if (mainDocuments !== 1) throw new Error("DOCX 主文档入口缺失或不唯一");
      continue;
    }
    const owner = posix.join(directory, posix.basename(path).slice(0, -5));
    const content = entries[owner];
    if (!content) throw new Error(`DOCX 关系缺少所属部件：${owner}`);
    for (const match of decoder.decode(content).matchAll(/\br:(?:id|embed|link)="([^"]+)"/g))
      if (!match[1] || !ids.has(match[1])) throw new Error(`DOCX 正文引用了缺失的关系：${owner}`);
  }
  for (const [owner, bytes] of Object.entries(entries)) {
    if (!owner.endsWith(".xml") || !/\br:(?:id|embed|link)="/.test(decoder.decode(bytes))) continue;
    const relation = posix.join(posix.dirname(owner), "_rels", `${posix.basename(owner)}.rels`);
    if (!names.has(relation)) throw new Error(`DOCX 正文缺少关系部件：${owner}`);
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 书签在正文与脚注间提供稳定身份；每个公式必须恰好绑定一个来源。 */
function collectEquationPositions(xml: string, result: Map<number, WordEquation>): void {
  const active = new Map<string, number>();
  let display = false;
  for (const match of xml.matchAll(
    /<w:bookmarkStart\b[^>]*\/>|<w:bookmarkEnd\b[^>]*\/>|<m:oMathPara(?:\s[^>]*)?>|<\/m:oMathPara>|<m:oMath(?:\s[^>]*)?>[\s\S]*?<\/m:oMath>/g,
  )) {
    const token = match[0];
    const id = /\bw:id="([^"]+)"/.exec(token)?.[1];
    if (token.startsWith("<m:oMathPara")) {
      if (display) throw new Error("DOCX 公式陈列结构嵌套");
      display = true;
    } else if (token === "</m:oMathPara>") display = false;
    else if (token.startsWith("<w:bookmarkStart")) {
      // 随包 Pandoc 3.12 会给 Word 书签加下划线前缀，来源核对使用实际输出身份。
      const name = /\bw:name="_noemori_eq_(\d+)"/.exec(token)?.[1];
      if (name) {
        const index = Number(name);
        if (!id || !Number.isSafeInteger(index) || index < 1 || active.has(id))
          throw new Error("DOCX 公式来源书签无效");
        active.set(id, index);
      }
    } else if (token.startsWith("<w:bookmarkEnd")) {
      if (id) active.delete(id);
    } else {
      const index = [...active.values()][0];
      if (active.size !== 1 || index === undefined || result.has(index))
        throw new Error("DOCX 公式来源重复或缺失");
      result.set(index, { xml: token, display });
    }
  }
  if (active.size) throw new Error("DOCX 公式来源书签未闭合");
}

/** 对源顺序、运算符和参数边界逐项核对；相同字符不能掩盖数学含义改变。 */
function validateEquationContent(
  equations: readonly WordEquation[],
  expected: readonly FormulaExpectation[],
): void {
  for (const [index, formula] of expected.entries()) {
    try {
      const equation = equations[index];
      if (equation && equation.display !== formula.display)
        throw new Error(`DOCX 第 ${index + 1} 个公式的行内／陈列结构不一致`);
      if (
        !equation ||
        equationSignature(equation.xml, "omml") !== equationSignature(formula.mathml, "mathml")
      )
        throw new Error(`DOCX 第 ${index + 1} 个公式的原生结构或内容不一致`);
    } catch (error) {
      throw new ExportFailure([
        {
          path: formula.location.path,
          ...(formula.location.line === null ? {} : { line: formula.location.line }),
          severity: "error",
          message: errorText(error),
        },
      ]);
    }
  }
}
