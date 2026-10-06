import { describe, expect, it } from "vitest";
import {
  DEFAULT_READING_PALETTE,
  READING_PALETTES,
  parseReadingPalette,
} from "@reader/shared/reading-palette";
import { parseSession } from "../../../../../modules/notes/packages/desktop/src/main/session";

describe("阅读配色契约", () => {
  it("只提供黑白和绿色，缺省选择黑白", () => {
    expect(Object.keys(READING_PALETTES)).toEqual(["monochrome", "green"]);
    expect(DEFAULT_READING_PALETTE).toBe("monochrome");
    expect(parseReadingPalette("monochrome")).toBe("monochrome");
    expect(parseReadingPalette("green")).toBe("green");
    for (const value of [undefined, null, "blue", "__proto__", "constructor", {}, [], 1, true])
      expect(parseReadingPalette(value)).toBeNull();
  });

  it("应用会话恢复配色，旧会话和非法值采用黑白", () => {
    for (const readingPalette of ["monochrome", "green"])
      expect(parseSession(JSON.stringify({ readingPalette }))).toHaveProperty(
        "readingPalette",
        readingPalette,
      );
    for (const readingPalette of [undefined, null, "blue", {}, 1, true])
      expect(parseSession(JSON.stringify({ readingPalette }))).toHaveProperty(
        "readingPalette",
        "monochrome",
      );
  });
});
