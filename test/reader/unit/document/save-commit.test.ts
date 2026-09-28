import { describe, expect, it } from "vitest";
import { commitSuccessfulWrite } from "@reader/renderer/engine/document/save";

describe("commitSuccessfulWrite", () => {
  const written = new TextEncoder().encode("on disk\n");

  it("clears dirty only when the serialized generation is still current", () => {
    const commit = commitSuccessfulWrite(written, 3, 3);
    expect(commit.dirty).toBe(false);
    expect(commit.originalBytes).toBe(written);
  });

  it("keeps dirty when the buffer moved on during the write", () => {
    const commit = commitSuccessfulWrite(written, 3, 4);
    expect(commit.dirty).toBe(true);
    expect(commit.originalBytes).toBe(written);
  });
});
