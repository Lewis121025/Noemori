import { XMLParser } from "fast-xml-parser";
import { mathCharacters, wordMathCharacters } from "./math-characters";

/** 数学内容有序树；表达式容器不参与比较，运算顺序和参数边界必须参与。 */
type Expression = (string | Expression)[];
type Element = {
  name: string;
  attributes: Record<string, string>;
  children: Element[];
  text: string;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function elements(value: unknown): Element[] {
  if (!Array.isArray(value)) throw new Error("数学 XML 子树无效");
  return value.flatMap((item: unknown): Element[] => {
    if (!record(item)) throw new Error("数学 XML 节点无效");
    const attributes: Record<string, string> = {};
    if (item[":@"] !== undefined) {
      if (!record(item[":@"])) throw new Error("数学 XML 属性无效");
      for (const [key, value] of Object.entries(item[":@"])) {
        if (typeof value !== "string") throw new Error("数学 XML 属性值无效");
        attributes[key] = value;
      }
    }
    return Object.entries(item).flatMap(([name, content]): Element[] => {
      if (name === ":@" || name.startsWith("?")) return [];
      if (name === "#text") {
        if (typeof content !== "string") throw new Error("数学 XML 文字无效");
        return [{ name, attributes: {}, children: [], text: content }];
      }
      return [{ name, attributes, children: elements(content), text: "" }];
    });
  });
}

function children(node: Element): Element[] {
  return node.children.filter((child) => child.name !== "#text");
}
function text(node: Element): string {
  return node.text + node.children.map(text).join("");
}
function characters(value: string): Expression {
  return mathCharacters(value);
}
function accent(value: string): Expression {
  const equivalents: Record<string, string> = {
    "\u20d7": "→",
    "\u0302": "^",
    "\u0303": "~",
    "\u0304": "―",
    "¯": "―",
  };
  return characters(equivalents[value] ?? value);
}
function script(base: Expression, lower: Expression, upper: Expression): Expression {
  return lower.length || upper.length ? [["script", base, lower, upper]] : base;
}

function mathml(node: Element, inheritedVariant?: string): Expression {
  const items = children(node);
  const variant = node.attributes["mathvariant"] ?? inheritedVariant;
  const values = items.map((item) => mathml(item, variant));
  const argument = (index: number): Expression => {
    const value = values[index];
    if (!value) throw new Error(`MathML ${node.name} 缺少参数`);
    return value;
  };
  switch (node.name) {
    case "math":
    case "mrow":
    case "mstyle":
    case "mtd":
      return values.flat();
    case "mi":
      return mathCharacters(
        text(node),
        variant ?? ([...text(node)].length === 1 ? "italic" : "normal"),
      );
    case "mn":
    case "mo":
      return mathCharacters(text(node), variant ?? "normal");
    case "mtext":
      return [["text", text(node).normalize("NFC")]];
    case "mspace":
      return [];
    case "mfrac":
      return [
        [node.attributes["linethickness"] === "0" ? "noBar" : "fraction", argument(0), argument(1)],
      ];
    case "msqrt":
      return [["root", ["2"], values.flat()]];
    case "mroot":
      return [["root", argument(1), argument(0)]];
    case "msub":
    case "munder":
      return script(argument(0), argument(1), []);
    case "msup":
    case "mover":
      return script(argument(0), [], argument(1));
    case "msubsup":
    case "munderover":
      return script(argument(0), argument(1), argument(2));
    case "mtr":
      return values;
    case "mtable": {
      const aligned =
        node.attributes["columnalign"]?.startsWith("right left") &&
        node.attributes["columnspacing"] === "0em";
      return [
        [
          aligned ? "aligned" : "matrix",
          aligned
            ? items.map((row) => children(row).flatMap((cell) => mathml(cell, variant)))
            : values,
        ],
      ];
    }
    default:
      throw new Error(`尚不能独立核验此 MathML 结构：${node.name}`);
  }
}

function omml(node: Element): Expression {
  const items = children(node);
  const named = (name: string) => items.find((item) => item.name === name);
  const argument = (name: string, optional = false): Expression => {
    const child = named(name);
    if (!child && !optional) throw new Error(`OMML ${node.name} 缺少 ${name}`);
    return child ? omml(child) : [];
  };
  const property = (name: string, fallback: string): string => {
    const properties = named(`${node.name}Pr`);
    return (
      properties?.children.find((item) => item.name === `m:${name}`)?.attributes["m:val"] ??
      fallback
    );
  };
  const content = () => items.filter((item) => !item.name.endsWith("Pr")).flatMap(omml);
  switch (node.name) {
    case "m:oMath":
    case "m:e":
    case "m:num":
    case "m:den":
    case "m:sub":
    case "m:sup":
    case "m:deg":
    case "m:lim":
    case "m:fName":
      return content();
    case "m:r": {
      const value = named("m:t");
      if (!value) throw new Error("OMML 数学文字缺少 m:t");
      if (named("m:rPr")?.children.some((item) => item.name === "m:nor"))
        return [["text", text(value).normalize("NFC")]];
      return wordMathCharacters(text(value), property("scr", "roman"), property("sty", "i"));
    }
    case "m:t":
      return characters(text(node));
    case "m:f":
      return [
        [
          property("type", "bar") === "noBar" ? "noBar" : "fraction",
          argument("m:num"),
          argument("m:den"),
        ],
      ];
    case "m:rad": {
      const degree = argument("m:deg", true);
      return [["root", degree.length ? degree : ["2"], argument("m:e")]];
    }
    case "m:sSub":
    case "m:sSup":
    case "m:sSubSup":
      return script(
        argument("m:e"),
        argument("m:sub", node.name === "m:sSup"),
        argument("m:sup", node.name === "m:sSub"),
      );
    case "m:limLow":
      return script(argument("m:e"), argument("m:lim"), []);
    case "m:limUpp":
      return script(argument("m:e"), [], argument("m:lim"));
    case "m:bar":
      return property("pos", "bot") === "top"
        ? script(argument("m:e"), [], ["―"])
        : script(argument("m:e"), ["―"], []);
    case "m:acc":
      return script(argument("m:e"), [], accent(property("chr", "\u0302")));
    case "m:nary":
      return [
        ...script(
          characters(property("chr", "∫")),
          argument("m:sub", true),
          argument("m:sup", true),
        ),
        ...argument("m:e"),
      ];
    case "m:d":
      return [
        ...characters(property("begChr", "(")),
        ...items
          .filter((item) => item.name === "m:e")
          .flatMap((item, index) => [
            ...(index ? characters(property("sepChr", "|")) : []),
            ...omml(item),
          ]),
        ...characters(property("endChr", ")")),
      ];
    case "m:m":
      return [
        [
          "matrix",
          items.filter((item) => item.name === "m:mr").map((row) => children(row).map(omml)),
        ],
      ];
    case "m:eqArr":
      return [
        [
          "aligned",
          items
            .filter((item) => item.name === "m:e")
            .map((row) => omml(row).filter((value) => value !== "&")),
        ],
      ];
    case "m:func":
      return [...argument("m:fName"), ...argument("m:e")];
    default:
      throw new Error(`尚不能独立核验此 OMML 结构：${node.name}`);
  }
}

/** 独立规范化 MathML 与 OMML 的有序数学结构；未知结构明确拒绝，禁止退回字符集合比较。 */
export function equationSignature(xml: string, format: "mathml" | "omml"): string {
  const parser = new XMLParser({
    preserveOrder: true,
    htmlEntities: true,
    ignoreAttributes: false,
    attributeNamePrefix: "",
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: false,
  });
  const parsed: unknown = parser.parse(xml);
  const roots = elements(parsed).filter((node) => node.name !== "#text");
  if (
    roots.length !== 1 ||
    !roots[0] ||
    roots[0].name !== (format === "mathml" ? "math" : "m:oMath")
  )
    throw new Error("数学 XML 根结构无效");
  return JSON.stringify(format === "mathml" ? mathml(roots[0]) : omml(roots[0]));
}
