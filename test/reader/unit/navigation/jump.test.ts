/**
 * @vitest-environment jsdom
 */
import { flushSync, mount, unmount, type Component } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import DocumentEditor from "@reader/renderer/components/editors/DocumentEditor.svelte";
import type { MarkdownEditorApi } from "@reader/renderer/engine/editing/editor-api";
import type { OutlineItem } from "@reader/renderer/engine/navigation/outline";

const OriginalScrollIntoView = HTMLElement.prototype.scrollIntoView;

describe("outline jump", () => {
  afterEach(() => {
    HTMLElement.prototype.scrollIntoView = OriginalScrollIntoView;
  });

  it("scrolls the heading to the start of the reading pane, not just barely into view", () => {
    const scrolled: Array<{ tag: string; text: string; options: unknown }> = [];
    HTMLElement.prototype.scrollIntoView = function scrollIntoView(this: HTMLElement, options?: unknown) {
      scrolled.push({
        tag: this.tagName,
        text: this.textContent?.trim() ?? "",
        options,
      });
    };

    const target = document.createElement("div");
    document.body.append(target);
    let api: MarkdownEditorApi | null = null;
    let outline: OutlineItem[] = [];
    const app = mount(DocumentEditor as Component, {
      target,
      props: {
        path: "Note.md",
        source: "# Alpha\n\nintro\n\n# Beta\n\nbody\n",
        onDirty: () => {},
        onSave: () => {},
        onOpenLink: () => {},
        onOutline: (items: OutlineItem[]) => {
          outline = items;
        },
        register: (next: MarkdownEditorApi | null) => {
          api = next;
        },
      },
    });
    flushSync();

    const beta = outline.find((item) => item.text === "Beta");
    expect(api).not.toBeNull();
    expect(beta).toBeDefined();
    api?.jumpTo(beta?.pos ?? -1);

    expect(scrolled).toContainEqual({
      tag: "H1",
      text: "Beta",
      options: { block: "start", inline: "nearest" },
    });

    unmount(app);
    target.remove();
  });
});

describe("mention jump", () => {
  afterEach(() => {
    HTMLElement.prototype.scrollIntoView = OriginalScrollIntoView;
  });

  it("scrolls a wiki mention to the center of the reading pane", () => {
    const scrolled: Array<{ tag: string; text: string; options: unknown }> = [];
    HTMLElement.prototype.scrollIntoView = function scrollIntoView(this: HTMLElement, options?: unknown) {
      scrolled.push({
        tag: this.tagName,
        text: this.textContent?.trim() ?? "",
        options,
      });
    };

    const target = document.createElement("div");
    document.body.append(target);
    let api: MarkdownEditorApi | null = null;
    const app = mount(DocumentEditor as Component, {
      target,
      props: {
        path: "Note.md",
        source: "intro\n\nSee [[Target]] here\n",
        onDirty: () => {},
        onSave: () => {},
        onOpenLink: () => {},
        onOutline: () => {},
        register: (next: MarkdownEditorApi | null) => {
          api = next;
        },
      },
    });
    flushSync();

    expect(api).not.toBeNull();
    api?.jumpToMention({ kind: "linked", linkKind: "wiki", toRaw: "Target" }, 1);

    expect(scrolled.some((item) => item.options && typeof item.options === "object" && "block" in item.options && item.options.block === "center")).toBe(true);

    unmount(app);
    target.remove();
  });

  it("jumps to unlinked paragraph text without throwing", () => {
    const target = document.createElement("div");
    const main = document.createElement("div");
    main.className = "main";
    main.append(target);
    document.body.append(main);
    let api: MarkdownEditorApi | null = null;
    const app = mount(DocumentEditor as Component, {
      target,
      props: {
        path: "Note.md",
        source: `${"para\n\n".repeat(40)}UniqueHitWord in a paragraph\n`,
        onDirty: () => {},
        onSave: () => {},
        onOpenLink: () => {},
        onOutline: () => {},
        register: (next: MarkdownEditorApi | null) => {
          api = next;
        },
      },
    });
    flushSync();

    expect(api).not.toBeNull();
    expect(() => {
      api?.jumpToMention({ kind: "unlinked", linkKind: null, toRaw: "UniqueHitWord" }, 1);
    }).not.toThrow();

    unmount(app);
    main.remove();
  });
});
