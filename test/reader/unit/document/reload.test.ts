import { describe, expect, it } from "vitest";
import { shouldApplyReload, shouldReloadSource } from "@reader/renderer/engine/document/reload";

describe("shouldReloadSource", () => {
  const original = new TextEncoder().encode("# Note\n");

  it("does not reload while the buffer is dirty", () => {
    const disk = new TextEncoder().encode("# Other\n");
    expect(shouldReloadSource(true, original, disk)).toBe(false);
  });

  it("does not reload when disk bytes match the last write", () => {
    expect(shouldReloadSource(false, original, original.slice())).toBe(false);
  });

  it("reloads a clean buffer when disk bytes differ", () => {
    const disk = new TextEncoder().encode("# External\n");
    expect(shouldReloadSource(false, original, disk)).toBe(true);
  });
});

describe("shouldApplyReload", () => {
  const original = new TextEncoder().encode("# Note\n");
  const disk = new TextEncoder().encode("# External\n");

  it("does not apply a read started for another file", () => {
    expect(
      shouldApplyReload({
        dirty: false,
        currentPath: "b.md",
        pathWhenStarted: "a.md",
        original,
        disk,
      }),
    ).toBe(false);
  });

  it("still skips when the user edited during the read", () => {
    expect(
      shouldApplyReload({
        dirty: true,
        currentPath: "a.md",
        pathWhenStarted: "a.md",
        original,
        disk,
      }),
    ).toBe(false);
  });
});
