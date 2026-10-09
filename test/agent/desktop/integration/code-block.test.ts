/** @vitest-environment jsdom */
import { flushSync, mount, unmount } from "svelte";
import { fromStore, writable } from "svelte/store";
import { LanguageDescription } from "../../../../modules/notes/packages/desktop/node_modules/@codemirror/language/dist/index.js";
import { languages } from "../../../../modules/notes/packages/desktop/node_modules/@codemirror/language-data/dist/index.js";
import { expect, it, onTestFinished, vi } from "vitest";
import CodeBlock from "../../../../modules/notes/packages/desktop/src/features/agent/renderer/CodeBlock.svelte";

function render(text: string, language: string) {
  const target = document.createElement("div");
  document.body.append(target);
  const store = writable({ text, language }), state = fromStore(store);
  const view = mount(CodeBlock, { target, props: {
    get text() { return state.current.text; },
    get language() { return state.current.language; },
  } });
  onTestFinished(async () => { await unmount(view); target.remove(); vi.restoreAllMocks(); });
  flushSync();
  return { target, store };
}

it("语法高亮不改变代码原文，也不把代码中的 HTML 当作页面执行", async () => {
  const text = 'const html = "<script>alert(1)</script>";\n  console.log(html);';
  const { target } = render(text, "javascript");
  await vi.waitFor(() => {
    flushSync();
    expect(target.querySelector(".tok-keyword")).not.toBeNull();
  });
  expect(target.querySelector("pre code")?.textContent).toBe(text);
  expect(target.querySelector("script")).toBeNull();
});

it("未知语言与超长代码保留全文，无须语言解析器才能阅读", () => {
  const text = "完整原文\n".repeat(12000);
  const { target } = render(text, "custom-language");
  expect(target.querySelector("pre code")?.textContent).toBe(text);
});

it("迟到的语言加载不能覆盖已经切换的代码", async () => {
  const description = LanguageDescription.matchLanguageName(languages, "javascript", false)!;
  const original = LanguageDescription.prototype.load;
  const loading = Promise.withResolvers<Awaited<ReturnType<typeof original>>>();
  vi.spyOn(LanguageDescription.prototype, "load").mockImplementationOnce(() => loading.promise);
  const { target, store } = render("const old = 1;", "javascript");
  store.set({ text: "新的原文", language: "unknown" });
  flushSync();
  loading.resolve(await original.call(description));
  await loading.promise;
  flushSync();
  expect(target.querySelector("pre code")?.textContent).toBe("新的原文");
});

it("语言加载失败保留代码全文，并留下可诊断的错误", async () => {
  vi.spyOn(LanguageDescription.prototype, "load").mockRejectedValueOnce(new Error("语言模块不可用"));
  const diagnostic = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { target } = render("const keep = 1;", "javascript");
  await vi.waitFor(() => expect(diagnostic).toHaveBeenCalledOnce());
  expect(target.querySelector("pre code")?.textContent).toBe("const keep = 1;");
});
