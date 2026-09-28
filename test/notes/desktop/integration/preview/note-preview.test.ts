/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { mountNotePreview } from "@reader/renderer/markdown/views/content-view";
import type { MediaIo } from "@reader/renderer/preview/media";

vi.mock("@reader/renderer/markdown/views/mathjax", () => ({
  peekRenderedTex: () => null,
  renderTex: async (tex: string) => {
    const rendered = document.createElement("span");
    rendered.className = "rendered-math";
    rendered.textContent = tex;
    return rendered;
  },
}));

const previews: Array<{ destroy: () => void }> = [];
afterEach(() => {
  for (const preview of previews) preview.destroy();
  previews.length = 0;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it("预览使用目标笔记的路径渲染公式和图片，并在销毁时释放资源", async () => {
  const revoke = vi.fn();
  vi.stubGlobal(
    "URL",
    class extends URL {
      static revokeObjectURL = revoke;
    },
  );
  const source = "# 资料\n\n公式 $E=mc^2$。\n\n![图片](image.png)\n\n- [ ] 任务\n";
  const io: MediaIo = {
    resolveLink: vi.fn(async (from, raw) =>
      raw === "资料" ? "notes/资料.md" : `${from.slice(0, from.lastIndexOf("/"))}/${raw}`,
    ),
    readFile: vi.fn(async (path) =>
      new TextEncoder().encode(path.endsWith(".md") ? source : "image"),
    ),
    createUrl: vi.fn(() => "blob:note-preview"),
  };
  const host = document.createElement("div");
  document.body.append(host);
  const preview = mountNotePreview(host, {
    from: "home.md",
    target: "资料",
    kind: "wiki",
    anchor: null,
    io,
    openLink: vi.fn(),
    depth: 0,
    chain: [],
  });
  previews.push(preview);
  await vi.waitFor(() => expect(host.querySelector(".rendered-math")?.textContent).toBe("E=mc^2"));
  await vi.waitFor(() =>
    expect(host.querySelector("img")?.getAttribute("src")).toBe("blob:note-preview"),
  );
  expect(io.resolveLink).toHaveBeenCalledWith("notes/资料.md", "image.png", "md");
  expect(host.querySelector<HTMLButtonElement>(".task-checkbox")?.disabled).toBe(true);
  preview.destroy();
  previews.length = 0;
  expect(revoke).toHaveBeenCalledWith("blob:note-preview");
});

it("预览内部链接携带来源路径，关闭预览后迟到的图片仍被释放", async () => {
  let complete!: (bytes: Uint8Array) => void;
  const image = new Promise<Uint8Array>((resolve) => {
    complete = resolve;
  });
  const revoke = vi.fn();
  vi.stubGlobal(
    "URL",
    class extends URL {
      static revokeObjectURL = revoke;
    },
  );
  const io: MediaIo = {
    resolveLink: vi.fn(async (_from, raw) =>
      raw === "资料" ? "notes/资料.md" : "notes/image.png",
    ),
    readFile: vi.fn(async (path) =>
      path.endsWith(".md")
        ? new TextEncoder().encode("[继续](./next.md)\n\n![图片](image.png)")
        : image,
    ),
    createUrl: vi.fn(() => "blob:late-image"),
  };
  const openLink = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const preview = mountNotePreview(host, {
    from: "home.md",
    target: "资料",
    kind: "wiki",
    anchor: null,
    io,
    openLink,
    depth: 0,
    chain: [],
  });
  previews.push(preview);
  await vi.waitFor(() => expect(io.readFile).toHaveBeenCalledWith("notes/image.png"));
  host.querySelector<HTMLAnchorElement>("a")?.click();
  expect(openLink).toHaveBeenCalledWith("md", "./next.md", "notes/资料.md");
  preview.destroy();
  previews.length = 0;
  complete(new Uint8Array([1]));
  await vi.waitFor(() => expect(revoke).toHaveBeenCalledWith("blob:late-image"));
  expect(host.querySelector(".ProseMirror")).toBeNull();
});

it("嵌入与悬停预览中的标注保持初始收起，从标题进入正文时才展开", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const io: MediaIo = {
    resolveLink: async () => "资料.md",
    readFile: async () => new TextEncoder().encode("> [!note]- 提示\n> 标注正文\n"),
    createUrl: () => "",
  };
  previews.push(
    mountNotePreview(host, {
      from: "home.md",
      target: "资料",
      kind: "wiki",
      anchor: null,
      io,
      openLink: vi.fn(),
      depth: 0,
      chain: [],
    }),
  );
  await vi.waitFor(() => expect(host.querySelector(".callout")).not.toBeNull());
  const callout = host.querySelector<HTMLElement>(".callout")!;
  const title = callout.querySelector<HTMLInputElement>(".callout-title")!;
  expect(callout.classList.contains("collapsed")).toBe(true);
  expect(title.readOnly).toBe(true);
  // jsdom 不排版，只验证正文焦点与展开状态；实际滚动由桌面旅程覆盖。
  Range.prototype.getClientRects = () => Object.assign([], { item: () => null });
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  try {
    title.focus();
    title.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(callout.classList.contains("collapsed")).toBe(false);
    expect(document.activeElement).toBe(host.querySelector(".ProseMirror"));
    expect(
      callout
        .querySelector(".callout-content")!
        .contains(document.getSelection()?.anchorNode ?? null),
    ).toBe(true);
  } finally {
    Reflect.deleteProperty(Range.prototype, "getClientRects");
    Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
  }
});
