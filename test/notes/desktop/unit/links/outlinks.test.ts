import { describe, expect, it } from "vitest";
import { presentOutlinks } from "@reader/renderer/links/outlinks";
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
    expect(groups.resolved.map((group) => group.items[0].toRaw)).toEqual(["a", "b"]);
    expect(groups.dead.map((group) => group.items[0].toRaw)).toEqual(["dead"]);
    expect(groups.ambiguous.map((group) => group.items[0].toRaw)).toEqual(["foo"]);
    expect(groups.self.map((group) => group.items[0].toRaw)).toEqual(["#节"]);
  });

  it("空出链产出空分组", () => {
    expect(presentOutlinks([])).toEqual({ resolved: [], ambiguous: [], dead: [], self: [] });
  });

  it("显式文件路径指向自身时也归入内部跳转，保留原始解析与标题", () => {
    const anchor = link("ref#本节", "ref.md", "resolved");
    const groups = presentOutlinks([anchor, link("目标", "目标.md", "resolved")]);
    expect(groups.resolved).toHaveLength(1);
    expect(groups.self).toHaveLength(1);
    expect(groups.self[0]?.target).toBe("ref#本节");
    expect(groups.self[0]?.items).toEqual([anchor]);
    expect(anchor.resolution).toBe("resolved");
  });

  it("同一文件的别名和不同标题合为一个目标，保留全部原始跳转", () => {
    const first = link("目标#甲", "notes/目标.md", "resolved");
    const second = { ...link("别名#乙", "notes/目标.md", "resolved"), startByte: 10 };
    const other = link("另一篇", "other.md", "resolved");
    const groups = presentOutlinks([first, second, other]);
    expect(groups.resolved).toHaveLength(2);
    expect(groups.resolved[0]?.items).toEqual([first, second]);
    expect(groups.resolved[0]?.target).toBe("notes/目标.md");
  });

  it("未确定目标按状态与语法分别合并，本篇锚点独立保留", () => {
    const groups = presentOutlinks([
      link("缺失", null, "dead"),
      link("缺失", null, "dead"),
      { ...link("缺失", null, "dead"), kind: "md" },
      link("缺失", null, "ambiguous"),
      link("#节", null, "self"),
    ]);
    expect(groups.dead).toHaveLength(2);
    expect(groups.dead[0]?.items).toHaveLength(2);
    expect(groups.ambiguous).toHaveLength(1);
    expect(groups.self).toHaveLength(1);
  });
});
