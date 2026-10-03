import { liteAdaptor } from "@mathjax/src/js/adaptors/liteAdaptor.js";
import type { LiteElement } from "@mathjax/src/js/adaptors/lite/Element.js";
import type { LiteText } from "@mathjax/src/js/adaptors/lite/Text.js";
import type { LiteDocument } from "@mathjax/src/js/adaptors/lite/Document.js";
import { RegisterHTMLHandler } from "@mathjax/src/js/handlers/html.js";
import { HTMLMathItem } from "@mathjax/src/js/handlers/html/HTMLMathItem.js";
import { SerializedMmlVisitor } from "@mathjax/src/js/core/MmlTree/SerializedMmlVisitor.js";
import { TeX } from "@mathjax/src/js/input/tex.js";
import type TexError from "@mathjax/src/js/input/tex/TexError.js";
import { CommandMap } from "@mathjax/src/js/input/tex/TokenMap.js";
import type { Macro } from "@mathjax/src/js/input/tex/Token.js";
import BaseMethods from "@mathjax/src/js/input/tex/base/BaseMethods.js";
import "@mathjax/src/js/input/tex/ams/AmsConfiguration.js";
import "@mathjax/src/js/input/tex/boldsymbol/BoldsymbolConfiguration.js";
import "@mathjax/src/js/input/tex/newcommand/NewcommandConfiguration.js";
import "@mathjax/src/js/input/tex/textmacros/TextMacrosConfiguration.js";
import { mathjax } from "@mathjax/src/js/mathjax.js";
import type { Node as PmNode } from "prosemirror-model";
import type { PreparedExportDocument } from "./documents";
import { errorText, ExportFailure } from "./errors";

let registered = false;

/** 已展开宏的数学树和原节点；交给 Pandoc 前不经过手写 TeX 字符串替换。 */
export type CompiledFormula = {
  node: PmNode;
  mathml: string;
  display: boolean;
  tex: string;
  location: { path: string; line: number | null };
};

/** 产物验收只需要源数学语义及位置，不把编辑器节点跨线程复制。 */
export type FormulaExpectation = Pick<CompiledFormula, "mathml" | "display" | "location">;

/**
 * 从冻结正文独立建立公式出现序列，不读取 Pandoc 的计数或中间树。
 * 脚注每次引用产生一次内容；未被引用的定义按正文位置保留。
 * @throws 重复、缺失、循环脚注或未覆盖的源公式均阻止不完整的导出。
 */
export function expectedExportFormulas(
  document: PreparedExportDocument,
  compiled: readonly CompiledFormula[],
): CompiledFormula[] {
  const definitions = new Map<string, PmNode>();
  const referenced = new Set<string>();
  document.doc.descendants((node) => {
    const label = String(node.attrs["label"] ?? "");
    if (node.type.name === "footnote_ref") referenced.add(label);
    if (node.type.name === "footnote_def") {
      if (definitions.has(label)) throw new Error(`脚注定义重复：${label}`);
      definitions.set(label, node);
    }
  });
  const formulas = new Map(compiled.map((formula) => [formula.node, formula]));
  const visited = new Set<PmNode>();
  const active = new Set<string>();
  const result: CompiledFormula[] = [];
  const visit = (node: PmNode): void => {
    if (node.type.name === "footnote_ref") {
      const label = String(node.attrs["label"]);
      const definition = definitions.get(label);
      if (!definition || active.has(label)) throw new Error(`脚注缺失或循环：${label}`);
      active.add(label);
      visited.add(definition);
      definition.forEach(visit);
      active.delete(label);
      return;
    }
    if (node.type.name === "footnote_def") {
      if (referenced.has(String(node.attrs["label"]))) return;
      visited.add(node);
    }
    if (node.type.name === "math_inline" || node.type.name === "math_block") {
      const formula = formulas.get(node);
      if (!formula) throw new Error("源公式缺少严格编译记录");
      result.push(formula);
      visited.add(node);
    }
    node.forEach(visit);
  };
  visit(document.doc);
  if ([...definitions.values()].some((node) => !visited.has(node)))
    throw new Error("存在循环或不可达的脚注定义");
  if (compiled.some((formula) => !visited.has(formula.node)))
    throw new Error("源公式未进入独立验收清单");
  return result;
}

/** 将解析器确认过的简单宏环境放回公式前缀，保留原始 TeX 的对齐与定界语义。 */
function macroPrefix(macros: ReadonlyMap<string, Macro>): string {
  return [...macros]
    .map(([name, macro]) => {
      const [body, count, optional] = macro.args;
      const number = count === undefined || count === null || count === "" ? 0 : Number(count);
      if (
        macro.func !== BaseMethods.Macro ||
        typeof body !== "string" ||
        !Number.isInteger(number) ||
        number < 0 ||
        number > 9 ||
        (optional !== undefined && optional !== null && typeof optional !== "string")
      )
        throw new Error(`宏 \\${name} 的定义不能保持 Word 数学语义`);
      return `\\newcommand{\\${name}}${number ? `[${number}]` : ""}${typeof optional === "string" ? `[${optional}]` : ""}{${body}}`;
    })
    .join("");
}

/**
 * 严格编译一篇文档的公式，宏按正文顺序生效，下一篇使用独立解析器。
 * @throws 未知命令、语法错误、过量递归或无法承载的数学树均带原文位置拒绝。
 */
export function compileExportMath(document: PreparedExportDocument): CompiledFormula[] {
  if (!registered) {
    RegisterHTMLHandler(liteAdaptor());
    registered = true;
  }
  const tex = new TeX<LiteElement, LiteText, LiteDocument>({
    packages: ["base", "ams", "boldsymbol", "newcommand", "textmacros"],
    formatError: (_jax: unknown, error: TexError) => {
      throw new Error(error.message);
    },
  });
  const html = mathjax.document("", { InputJax: tex });
  const commands = tex.parseOptions.handlers.retrieve("new-Command");
  if (!(commands instanceof CommandMap)) throw new Error("数学宏处理器类型不符");
  const macros = new Map<string, Macro>();
  const add = commands.add.bind(commands);
  const remove = commands.remove.bind(commands);
  // 只观察本篇解析器的公开变更接口，不读私有字段、不改全局命令处理函数。
  commands.add = (name, macro) => {
    macros.set(name, macro);
    add(name, macro);
  };
  commands.remove = (name) => {
    macros.delete(name);
    remove(name);
  };
  const visitor = new SerializedMmlVisitor();
  const result: CompiledFormula[] = [];
  document.doc.descendants((node) => {
    if (node.type.name !== "math_inline" && node.type.name !== "math_block") return;
    const display = node.type.name === "math_block";
    const origin = document.formulaLocations.get(node);
    const location = { path: origin?.path ?? document.path, line: origin?.line ?? null };
    const item = new HTMLMathItem(String(node.attrs["tex"]), tex, display);
    try {
      const prefix = macroPrefix(macros);
      item.compile(html);
      const mathml = visitor.visitTree(item.root);
      if (/<(?:merror|annotation|annotation-xml)(?:\s|>)/.test(mathml))
        throw new Error("数学树含有无法保留的错误或注解");
      result.push({ node, mathml, display, tex: prefix + String(node.attrs["tex"]), location });
    } catch (error) {
      throw new ExportFailure([
        {
          path: location.path,
          ...(location.line === null ? {} : { line: location.line }),
          severity: "error",
          message: `第 ${result.length + 1} 个公式无法导出：${errorText(error)}`,
        },
      ]);
    }
  });
  return result;
}
