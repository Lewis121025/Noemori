/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import {
  previewKindFromReference,
  isRemoteMediaSrc,
  mimeFromPath,
  resolveMediaUrl,
  rewriteMediaSrcs,
  type MediaIo,
} from "@reader/renderer/engine/media/media";

describe("media helpers", () => {
  it("recognizes wiki image filenames and remote urls", () => {
    expect(previewKindFromReference("shot.jpg")).toBe("image");
    expect(previewKindFromReference("shot.jpg#crop")).toBe("image");
    expect(previewKindFromReference("folder/a.PNG")).toBe("image");
    expect(previewKindFromReference("paper.PDF?page=1#section")).toBe("pdf");
    expect(previewKindFromReference("Other")).toBeNull();
    expect(isRemoteMediaSrc("https://ex.test/a.png")).toBe(true);
    expect(isRemoteMediaSrc("data:image/png;base64,xx")).toBe(true);
    expect(isRemoteMediaSrc("./a.png")).toBe(false);
    expect(mimeFromPath("a.webp")).toBe("image/webp");
  });

  it("returns remote urls without reading the vault", async () => {
    const io: MediaIo = {
      resolveLink: async () => {
        throw new Error("should not resolve");
      },
      readFile: async () => {
        throw new Error("should not read");
      },
      createUrl: () => {
        throw new Error("should not blob");
      },
    };
    await expect(resolveMediaUrl("note.md", "https://ex.test/a.png", "md", io)).resolves.toBe(
      "https://ex.test/a.png",
    );
  });

  it("reads vault files through injected io", async () => {
    const io: MediaIo = {
      resolveLink: async (_from, raw, kind) => {
        expect(raw).toBe("./pic.png");
        expect(kind).toBe("md");
        return "assets/pic.png";
      },
      readFile: async (rel) => {
        expect(rel).toBe("assets/pic.png");
        return new Uint8Array([1, 2, 3]);
      },
      createUrl: (bytes, mime) => {
        expect(Array.from(bytes)).toEqual([1, 2, 3]);
        expect(mime).toBe("image/png");
        return "blob:test";
      },
    };
    await expect(resolveMediaUrl("note.md", "./pic.png", "md", io)).resolves.toBe("blob:test");
  });

  it("returns null when the vault path cannot be resolved", async () => {
    const io: MediaIo = {
      resolveLink: async () => null,
      readFile: async () => new Uint8Array(),
      createUrl: () => "blob:nope",
    };
    await expect(resolveMediaUrl("note.md", "missing.png", "md", io)).resolves.toBeNull();
  });
});

describe("html img rewrite", () => {
  it("isolates a rejected image load so the remaining images still render", async () => {
    const root = document.createElement("div");
    root.innerHTML = '<img src="missing.png"><img src="available.png">';
    await rewriteMediaSrcs(root, async (src) => {
      if (src === "missing.png") throw new Error("文件读取失败");
      return "blob:available";
    });
    const images = root.querySelectorAll("img");
    expect(images[0]?.hasAttribute("src")).toBe(false);
    expect(images[1]?.getAttribute("src")).toBe("blob:available");
  });

  it("rewrites relative img src and leaves remote src", async () => {
    const root = document.createElement("div");
    root.innerHTML = '<img src="./x.png"><img src="https://ex.test/a.png">';
    await rewriteMediaSrcs(root, async (src) => {
      expect(src).toBe("./x.png");
      return "blob:local";
    });
    const imgs = root.querySelectorAll("img");
    expect(imgs[0]?.getAttribute("src")).toBe("blob:local");
    expect(imgs[1]?.getAttribute("src")).toBe("https://ex.test/a.png");
  });

  it("clears relative src when load fails", async () => {
    const root = document.createElement("div");
    root.innerHTML = '<img src="./missing.png">';
    await rewriteMediaSrcs(root, async () => null);
    expect(root.querySelector("img")?.getAttribute("src")).toBeNull();
  });
});
