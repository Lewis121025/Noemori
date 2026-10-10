import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const sourceRoot = fileURLToPath(
  new URL("../../../../../modules/notes/packages/desktop/src/", import.meta.url),
);
const readerRoot = join(sourceRoot, "features/reader");

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sources(path) : /\.(ts|svelte)$/.test(path) ? [path] : [];
  });
}

function imports(path: string): string[] {
  const content = readFileSync(path, "utf8");
  const script = path.endsWith(".svelte")
    ? [...content.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
        .map((match) => match[1])
        .join("\n")
    : content;
  const tree = ts.createSourceFile(path, script, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      found.push(node.moduleSpecifier.text);
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    )
      found.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return found;
}

const layers: Record<string, readonly string[]> = {
  main: ["main", "shared"],
  preload: ["preload", "shared"],
  renderer: ["renderer", "shared"],
  shared: ["shared"],
};

describe("功能模块依赖边界", () => {
  it("文档、导航与工作区状态单向依赖，不反向引入界面组件", () => {
    const allowedStates: Record<string, readonly string[]> = {
      "document/state.svelte": [],
      "navigation/state.svelte": ["document/state.svelte"],
      "search/state.svelte": [],
      "library/state.svelte": [],
      "navigation/history.svelte": [],
      "workspace/pane.svelte": [
        "document/state.svelte",
        "navigation/state.svelte",
        "navigation/history.svelte",
      ],
      "workspace/state.svelte": [
        "workspace/pane.svelte",
        "search/state.svelte",
        "navigation/history.svelte",
        "library/state.svelte",
      ],
    };
    const violations: string[] = [];
    for (const [module, allowed] of Object.entries(allowedStates)) {
      const file = join(readerRoot, "renderer", `${module}.ts`);
      for (const specifier of imports(file)) {
        const target = specifier.startsWith(".")
          ? resolve(dirname(file), specifier)
          : specifier.startsWith("@reader/")
            ? resolve(readerRoot, specifier.slice(8))
            : null;
        if (target === null) continue;
        const to = relative(readerRoot, target);
        const rendererPath = to.replace(/^renderer\//, "").replace(/\.ts$/, "");
        const stateDependency = Object.hasOwn(allowedStates, rendererPath);
        if (
          (!to.startsWith("shared/") && !to.startsWith("renderer/")) ||
          (stateDependency && !allowed.includes(rendererPath)) ||
          (!stateDependency && target.endsWith(".svelte"))
        )
          violations.push(`${module} → ${specifier}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("阅读器不反向依赖外壳、其他功能或跨进程实现", () => {
    const violations: string[] = [];
    for (const file of sources(readerRoot)) {
      const from = relative(readerRoot, file);
      const layer = from.split("/")[0]!;
      for (const specifier of imports(file)) {
        const target = specifier.startsWith(".")
          ? resolve(dirname(file), specifier)
          : specifier.startsWith("@reader/")
            ? resolve(readerRoot, specifier.slice(8))
            : null;
        const to = target === null ? null : relative(readerRoot, target);
        if (
          specifier.startsWith("@app/") ||
          (to !== null && (to.startsWith("..") || !layers[layer]?.includes(to.split("/")[0]!))) ||
          ((layer === "renderer" || layer === "shared") &&
            (specifier.startsWith("node:") ||
              specifier === "electron" ||
              specifier === "@noemori/vault-node"))
        ) {
          violations.push(`${from} → ${specifier}`);
        }
      }
      if (/window\.noemori\b/.test(readFileSync(file, "utf8")))
        violations.push(`${from} 直接依赖全局应用桥接`);
    }
    expect(violations).toEqual([]);
  });
  it("外壳只通过功能入口和公开协议装配阅读器，不引用编辑器内部实现", () => {
    const violations: string[] = [];
    const entries = new Set([
      "main/service",
      "main/ipc",
      "preload/api",
      "renderer/ReaderWorkspace.svelte",
      "renderer/previews",
    ]);
    for (const file of sources(sourceRoot).filter((file) => !file.startsWith(readerRoot))) {
      for (const specifier of imports(file)) {
        if (!specifier.startsWith(".")) continue;
        const to = relative(readerRoot, resolve(dirname(file), specifier));
        if (!to.startsWith("..") && !to.startsWith("shared/") && !entries.has(to))
          violations.push(`${relative(sourceRoot, file)} → ${to}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
