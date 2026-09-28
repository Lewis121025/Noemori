import { describe, expect, it } from "vitest";
import type { MentionRecord } from "../../../../../modules/notes/packages/desktop/src/features/reader/shared/api";
import {
  displaySnippet,
  groupMentions,
  mentionOccurrenceIndex,
  presentMentions,
  type MentionSort,
} from "@reader/renderer/links/backlinks";

function mention(partial: Partial<MentionRecord> & Pick<MentionRecord, "fromPath" | "startByte">): MentionRecord {
  return {
    fromTitle: partial.fromTitle ?? partial.fromPath.replace(/\.md$/, ""),
    mtime: partial.mtime ?? 0,
    endByte: partial.endByte ?? partial.startByte + 1,
    snippet: partial.snippet ?? "body",
    kind: partial.kind ?? "linked",
    linkKind: partial.linkKind === undefined ? "wiki" : partial.linkKind,
    toRaw: partial.toRaw ?? "Target",
    fromPath: partial.fromPath,
    startByte: partial.startByte,
  };
}

describe("groupMentions", () => {
  it("keeps every mention and groups by source file in first-seen order", () => {
    const groups = groupMentions([
      mention({ fromPath: "A.md", startByte: 0 }),
      mention({ fromPath: "B.md", startByte: 10 }),
      mention({ fromPath: "A.md", startByte: 40 }),
    ]);
    expect(groups.map((group) => group.fromPath)).toEqual(["A.md", "B.md"]);
    expect(groups[0]?.items.map((item) => item.startByte)).toEqual([0, 40]);
    expect(groups[1]?.items.map((item) => item.startByte)).toEqual([10]);
  });
});

describe("presentMentions", () => {
  const rows = [
    mention({ fromPath: "B.md", fromTitle: "Beta", mtime: 2, startByte: 0, snippet: "see Target here" }),
    mention({ fromPath: "A.md", fromTitle: "Alpha", mtime: 9, startByte: 0, snippet: "other" }),
    mention({ fromPath: "C.md", fromTitle: "Gamma", mtime: 5, startByte: 0, snippet: "Target again" }),
  ];

  it("filters by path, title, or snippet case-insensitively", () => {
    const filtered = presentMentions(rows, { query: "target", sort: "pathAsc" });
    expect(filtered.map((group) => group.fromPath)).toEqual(["B.md", "C.md"]);
  });

  it("sorts groups by title A to Z and Z to A", () => {
    const asc = presentMentions(rows, { query: "", sort: "pathAsc" });
    expect(asc.map((group) => group.fromTitle)).toEqual(["Alpha", "Beta", "Gamma"]);
    const desc = presentMentions(rows, { query: "", sort: "pathDesc" });
    expect(desc.map((group) => group.fromTitle)).toEqual(["Gamma", "Beta", "Alpha"]);
  });

  it("sorts groups by mtime newest first and oldest first", () => {
    const newest: MentionSort = "mtimeDesc";
    expect(presentMentions(rows, { query: "", sort: newest }).map((group) => group.fromPath)).toEqual([
      "A.md",
      "C.md",
      "B.md",
    ]);
    expect(presentMentions(rows, { query: "", sort: "mtimeAsc" }).map((group) => group.fromPath)).toEqual([
      "B.md",
      "C.md",
      "A.md",
    ]);
  });
});

describe("displaySnippet", () => {
  it("returns the full paragraph when more context is on", () => {
    const snippet = "a".repeat(400);
    expect(displaySnippet(snippet, true)).toBe(snippet);
  });

  it("truncates long snippets and keeps the match when more context is off", () => {
    const snippet = `${"a".repeat(80)} TARGET ${"b".repeat(80)}`;
    const shown = displaySnippet(snippet, false, 40, "TARGET");
    expect(shown.length).toBeLessThan(snippet.length);
    expect(shown).toContain("TARGET");
    expect(shown.endsWith("…")).toBe(true);
  });
});

describe("mentionOccurrenceIndex", () => {
  it("counts same-file wiki links to the same target with startByte at or before this one", () => {
    const all = [
      mention({ fromPath: "A.md", startByte: 0, linkKind: "wiki", toRaw: "T" }),
      mention({ fromPath: "A.md", startByte: 10, linkKind: "md", toRaw: "./T.md" }),
      mention({ fromPath: "A.md", startByte: 20, linkKind: "wiki", toRaw: "T" }),
      mention({ fromPath: "B.md", startByte: 0, linkKind: "wiki", toRaw: "T" }),
    ];
    expect(mentionOccurrenceIndex(all, all[0]!)).toBe(1);
    expect(mentionOccurrenceIndex(all, all[2]!)).toBe(2);
    expect(mentionOccurrenceIndex(all, all[1]!)).toBe(1);
  });

  it("counts unlinked hits of the same needle in the same file", () => {
    const all = [
      mention({
        fromPath: "A.md",
        startByte: 4,
        kind: "unlinked",
        linkKind: null,
        toRaw: "Topic",
      }),
      mention({
        fromPath: "A.md",
        startByte: 20,
        kind: "unlinked",
        linkKind: null,
        toRaw: "topic",
      }),
    ];
    expect(mentionOccurrenceIndex(all, all[1]!)).toBe(2);
  });
});
