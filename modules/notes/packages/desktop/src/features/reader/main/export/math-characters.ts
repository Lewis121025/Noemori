/** Unicode 数学字母区间保留字形语义；仅这些字符可以分解成基础字母。 */
const ranges: readonly [number, number, string][] = [
  [0x1d400, 0x1d433, "bold"],
  [0x1d434, 0x1d467, "italic"],
  [0x1d468, 0x1d49b, "bold-italic"],
  [0x1d49c, 0x1d4cf, "script"],
  [0x1d4d0, 0x1d503, "bold-script"],
  [0x1d504, 0x1d537, "fraktur"],
  [0x1d538, 0x1d56b, "double-struck"],
  [0x1d56c, 0x1d59f, "bold-fraktur"],
  [0x1d5a0, 0x1d5d3, "sans-serif"],
  [0x1d5d4, 0x1d607, "bold-sans-serif"],
  [0x1d608, 0x1d63b, "sans-serif-italic"],
  [0x1d63c, 0x1d66f, "sans-serif-bold-italic"],
  [0x1d670, 0x1d6a3, "monospace"],
  [0x1d6a4, 0x1d6a5, "italic"],
  [0x1d6a8, 0x1d6e1, "bold"],
  [0x1d6e2, 0x1d71b, "italic"],
  [0x1d71c, 0x1d755, "bold-italic"],
  [0x1d756, 0x1d78f, "bold-sans-serif"],
  [0x1d790, 0x1d7c9, "sans-serif-bold-italic"],
  [0x1d7ca, 0x1d7cb, "bold"],
  [0x1d7ce, 0x1d7d7, "bold"],
  [0x1d7d8, 0x1d7e1, "double-struck"],
  [0x1d7e2, 0x1d7eb, "sans-serif"],
  [0x1d7ec, 0x1d7f5, "bold-sans-serif"],
  [0x1d7f6, 0x1d7ff, "monospace"],
];
const legacyGroups: readonly [string, string][] = [
  ["ℂℍℕℙℚℝℤ", "double-struck"],
  ["ℋℐℒℛℬℯℰℱℳℴ", "script"],
  ["ℌℑℜℨℭ", "fraktur"],
  ["ℎ", "italic"],
];
const legacy: Readonly<Record<string, string>> = Object.fromEntries(
  legacyGroups.flatMap(([letters, variant]) => [...letters].map((letter) => [letter, variant])),
);
const variants = new Set(["normal", ...ranges.map((range) => range[2])]);

/**
 * 比较字符及数学字形；禁止 NFKC 把带圈数字、黑板粗体或向量降级成同义字符。
 * @param variant MathML 或 OMML 明确指定的数学样式。
 * @throws 未支持的样式不能被忽略后继续验收。
 */
export function mathCharacters(value: string, variant = "normal"): (string | string[])[] {
  if (!variants.has(variant)) throw new Error(`尚不能核验此数学字形：${variant}`);
  return [...value.normalize("NFC").replace(/[\s\u2061\u2062]/gu, "")].map((character) => {
    const point = character.codePointAt(0) ?? 0;
    const unicodeVariant =
      legacy[character] ?? ranges.find(([start, end]) => point >= start && point <= end)?.[2];
    const form = unicodeVariant ?? variant;
    const base = unicodeVariant ? character.normalize("NFKC") : character;
    return form === "normal" ? base : ["letter", form, base];
  });
}

/** Word 默认斜体只作用于字母，数字与运算符默认直立；显式字形覆盖默认值。 */
export function wordMathCharacters(
  value: string,
  script: string,
  style: string,
): (string | string[])[] {
  const styles: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    roman: { p: "normal", b: "bold", i: "italic", bi: "bold-italic" },
    script: { p: "script", i: "script", b: "bold-script", bi: "bold-script" },
    fraktur: { p: "fraktur", b: "bold-fraktur" },
    "double-struck": { p: "double-struck" },
    "sans-serif": {
      p: "sans-serif",
      b: "bold-sans-serif",
      i: "sans-serif-italic",
      bi: "sans-serif-bold-italic",
    },
    monospace: { p: "monospace" },
  };
  const variant = styles[script]?.[style];
  if (!variant) throw new Error(`尚不能核验此 Word 数学字形：${script}/${style}`);
  return [...value].flatMap((character) =>
    mathCharacters(
      character,
      variant === "italic" && !/\p{L}/u.test(character) ? "normal" : variant,
    ),
  );
}
