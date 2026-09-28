import { describe, expect, it } from "vitest";
import { presentOutlinks } from "@reader/renderer/engine/navigation/outlinks";
import type { LinkRecord, LinkResolution } from "@reader/shared/api";

function link(toRaw: string, toPath: string | null, resolution: LinkResolution): LinkRecord {
  return {
    fromPath: "ref.md",
    toRaw,
    toPath,
    resolution,
    kind: "wiki",
    startByte: 0,
    endByte: 1,
  };
}

describe("presentOutlinks", () => {
  it("按解析状态分组并保持文档顺序", () => {
    const groups = presentOutlinks([
      link("a", "a.md", "resolved"),
      link("dead", null, "dead"),
      link("b", "b.md", "resolved"),
      link("foo", null, "ambiguous"),
      link("#节", null, "self"),
    ]);
    expect(groups.resolved.map((item) => item.toRaw)).toEqual(["a", "b"]);
    expect(groups.dead.map((item) => item.toRaw)).toEqual(["dead"]);
    expect(groups.ambiguous.map((item) => item.toRaw)).toEqual(["foo"]);
    expect(groups.self.map((item) => item.toRaw)).toEqual(["#节"]);
  });

  it("空出链产出空分组", () => {
    expect(presentOutlinks([])).toEqual({ resolved: [], ambiguous: [], dead: [], self: [] });
  });
});
