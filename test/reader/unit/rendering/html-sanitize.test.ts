/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { sanitizeHtml } from "@reader/renderer/engine/rendering/html";

function serialize(fragment: DocumentFragment): string {
  const wrap = document.createElement("div");
  wrap.append(fragment.cloneNode(true));
  return wrap.innerHTML;
}

describe("html sanitizer", () => {
  it("keeps empty named anchors so they can be painted", () => {
    const fragment = sanitizeHtml('<a id="complete_zero"></a>');
    const anchor = fragment.querySelector("a");
    expect(anchor).not.toBeNull();
    expect(anchor?.id).toBe("complete_zero");
    expect(anchor?.querySelector("script")).toBeNull();
  });

  it("strips script tags", () => {
    const fragment = sanitizeHtml('<p>ok</p><script>alert(1)</script>');
    expect(fragment.querySelectorAll("script")).toHaveLength(0);
    expect(serialize(fragment)).toContain("ok");
    expect(serialize(fragment)).not.toContain("<script");
  });

  it("strips event handlers but keeps the element", () => {
    const fragment = sanitizeHtml('<img src="x" onerror="alert(1)">');
    const img = fragment.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("onerror")).toBeNull();
    expect(serialize(fragment)).not.toContain("onerror");
  });

  it("blocks javascript urls on links", () => {
    const fragment = sanitizeHtml('<a href="javascript:alert(1)">x</a>');
    const anchor = fragment.querySelector("a");
    expect(anchor).not.toBeNull();
    expect(anchor?.getAttribute("href") ?? "").not.toMatch(/^javascript:/i);
  });
});
