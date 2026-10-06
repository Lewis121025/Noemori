/**
 * @vitest-environment jsdom
 */
import { flushSync, mount, unmount, type Component } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DocumentEditor from "@reader/renderer/editor/DocumentEditor.svelte";
import type { MarkdownEditorApi } from "@reader/renderer/editor/editor-api";
import { createBrowserMediaIo } from "@reader/renderer/preview/media";
import { createReaderApiMock } from "../../fixtures/reader-api-mock";

vi.mock("@reader/renderer/markdown/views/mathjax", () => ({
  peekRenderedTex: (tex: string, display: boolean) => {
    const el = document.createElement(display ? "div" : "span");
    el.className = "mjx-mock";
    el.textContent = tex;
    return el;
  },
  renderTex: async (tex: string, display: boolean) => {
    const el = document.createElement(display ? "div" : "span");
    el.className = "mjx-mock";
    el.textContent = tex;
    return el;
  },
}));

const resolveMediaUrl = vi.fn(async () => "blob:test-image");

vi.mock("@reader/renderer/preview/media", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@reader/renderer/preview/media")>();
  return {
    ...actual,
    resolveMediaUrl: (...args: Parameters<typeof actual.resolveMediaUrl>) =>
      resolveMediaUrl(...args),
  };
});

const OriginalObserver = globalThis.IntersectionObserver;

type Mounted = {
  target: HTMLDivElement;
  app: object;
};

let mounted: Mounted[] = [];

function muteIntersectionObserver(): void {
  class SilentObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.IntersectionObserver = SilentObserver as unknown as typeof IntersectionObserver;
}

function mountNote(source: string): HTMLDivElement {
  const target = document.createElement("div");
  document.body.append(target);
  const app = mount(DocumentEditor as Component, {
    target,
    props: {
      path: "Note.md",
      mediaIo: createBrowserMediaIo(createReaderApiMock()),
      importAttachment: async () => ({ path: "attachments/test.png", warning: null }),
      onAttachmentReport: () => {},
      source,
      onDirty: () => {},
      onSave: () => {},
      onOpenLink: () => {},
      onOutline: () => {},
      register: (_api: MarkdownEditorApi | null) => {},
    },
  });
  flushSync();
  mounted.push({ target, app });
  return target;
}

describe("nodeview preview on open", () => {
  beforeEach(() => {
    resolveMediaUrl.mockClear();
    resolveMediaUrl.mockResolvedValue("blob:test-image");
    if (typeof URL.revokeObjectURL !== "function") {
      URL.revokeObjectURL = () => {};
    }
    muteIntersectionObserver();
  });

  afterEach(() => {
    for (const item of mounted) {
      unmount(item.app);
      item.target.remove();
    }
    mounted = [];
    globalThis.IntersectionObserver = OriginalObserver;
  });

  it("paints html preview on mount even if intersection never fires", () => {
    const root = mountNote("<pre>\ndef SGD():\n    pass\n</pre>\n");
    const preview = root.querySelector(".html-block pre");
    expect(preview).not.toBeNull();
    expect(preview?.textContent).toContain("def SGD");
  });

  it("paints math preview on mount even if intersection never fires", () => {
    const root = mountNote("See $a+b$ here.\n");
    const preview = root.querySelector(".math-inline .mjx-mock");
    expect(preview).not.toBeNull();
    expect(preview?.textContent).toBe("a+b");
  });

  it("loads images on mount even if intersection never fires", async () => {
    const root = mountNote("![chart](./x.png)\n");
    await Promise.resolve();
    const img = root.querySelector("img.note-image");
    expect(resolveMediaUrl).toHaveBeenCalledTimes(1);
    expect(img?.getAttribute("src")).toBe("blob:test-image");
  });
});
