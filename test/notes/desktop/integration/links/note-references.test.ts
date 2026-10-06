/** @vitest-environment jsdom */
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import BacklinksPane from "@reader/renderer/links/BacklinksPane.svelte";
import OutlinksPane from "@reader/renderer/links/OutlinksPane.svelte";
import { presentOutlinks } from "@reader/renderer/links/outlinks";
import type { LinkRecord } from "@reader/shared/api";
import type {
  MentionRecord,
  Mentions,
} from "../../../../../modules/notes/packages/desktop/src/features/reader/shared/api";

const components = new Set<ReturnType<typeof mount>>();

function mention(
  fromPath: string,
  startByte: number,
  kind: "linked" | "unlinked" = "linked",
): MentionRecord {
  return {
    fromPath,
    fromTitle: fromPath,
    mtime: 1,
    startByte,
    endByte: startByte + 6,
    snippet: `第 ${startByte} 处提到目标笔记`,
    kind,
    linkKind: kind === "linked" ? "wiki" : null,
    toRaw: "目标笔记",
  };
}

function start(mentions: Mentions) {
  const target = document.createElement("div");
  document.body.append(target);
  const onOpen = vi.fn();
  const onLinkify = vi.fn();
  components.add(mount(BacklinksPane, { target, props: { mentions, onOpen, onLinkify } }));
  flushSync();
  return { target, onOpen, onLinkify };
}

afterEach(async () => {
  for (const component of components) await unmount(component);
  components.clear();
  document.body.replaceChildren();
});

describe("底部双链的引用列表", () => {
  it("出链按目标合并，同文件的多个标题仍能分别跳转，本篇锚点单独显示", () => {
    const records: LinkRecord[] = [
      {
        fromPath: "note.md",
        toRaw: "目标#甲",
        toPath: "notes/目标.md",
        resolution: "resolved",
        kind: "wiki",
        startByte: 1,
        endByte: 8,
      },
      {
        fromPath: "note.md",
        toRaw: "别名#乙",
        toPath: "notes/目标.md",
        resolution: "resolved",
        kind: "wiki",
        startByte: 20,
        endByte: 28,
      },
      {
        fromPath: "note.md",
        toRaw: "#本文",
        toPath: null,
        resolution: "self",
        kind: "md",
        startByte: 40,
        endByte: 50,
      },
    ];
    const target = document.createElement("div");
    document.body.append(target);
    const onOpen = vi.fn();
    components.add(
      mount(OutlinksPane, { target, props: { groups: presentOutlinks(records), onOpen } }),
    );
    flushSync();
    const card = target.querySelector(".outlink-group")!;
    expect(card.querySelector(".raw")?.textContent).toBe("目标.md");
    expect(card.querySelector(".occurrence-count")?.textContent).toBe("×2");
    expect(card.querySelectorAll(".occurrence")).toHaveLength(2);
    expect(card.querySelectorAll("button")).toHaveLength(2);
    card.querySelectorAll<HTMLButtonElement>(".occurrence")[1]!.click();
    expect(onOpen).toHaveBeenCalledWith(records[1]);
    expect(target.querySelector('[aria-label="本文内部跳转"]')).not.toBeNull();
    expect(target.querySelectorAll(".outlink-group")).toHaveLength(2);
  });
  it("按来源笔记分组，直接展示摘要并保留每次出现的跳转", () => {
    const linked = [mention("来源甲.md", 0), mention("来源甲.md", 12), mention("来源乙.md", 0)];
    const { target, onOpen } = start({ linked, unlinked: [] });
    expect(target.querySelector('.linked-references[aria-label="入链"]')).not.toBeNull();
    expect(target.querySelector("h2")).toBeNull();
    expect(target.querySelector("details")).toBeNull();
    expect(target.querySelectorAll(".group")).toHaveLength(2);
    const hits = target.querySelectorAll<HTMLButtonElement>(".hit");
    expect(hits).toHaveLength(3);
    hits[1]!.click();
    expect(onOpen).toHaveBeenCalledWith(linked[1]);
  });

  it("候选提及单独标注，不计为已经引用的笔记", () => {
    const { target } = start({ linked: [], unlinked: [mention("来源.md", 0, "unlinked")] });
    expect(target.querySelector('.suggestions[aria-label="未链接提及"]')).not.toBeNull();
    expect(target.querySelector(".linked-references")).toBeNull();
    expect(target.querySelector("details")).toBeNull();
  });

  it("没有关联时不展示空面板", () => {
    const { target } = start({ linked: [], unlinked: [] });
    expect(target.querySelector("section")).toBeNull();
    expect(target.textContent?.trim()).toBe("");
  });

  it("同段落的重复入链只显示一份摘要，数字入口分别定位原始引用", () => {
    const first = mention("来源.md", 0);
    const second = { ...first, startByte: 20, endByte: 26 };
    const { target, onOpen } = start({ linked: [first, second], unlinked: [] });
    expect(target.querySelectorAll(".hit")).toHaveLength(1);
    expect(target.querySelector(".occurrence-count")?.textContent).toBe("×2");
    const positions = target.querySelectorAll<HTMLButtonElement>(".occurrence");
    expect(positions).toHaveLength(2);
    expect(target.querySelectorAll("button")).toHaveLength(2);
    positions[1]!.click();
    expect(onOpen).toHaveBeenCalledWith(second);
  });

  it("只有未链接提及带「转为链接」动作，点击回传整条提及", () => {
    const linked = [mention("来源甲.md", 0)];
    const unlinked = [mention("来源乙.md", 40, "unlinked")];
    const { target, onLinkify } = start({ linked, unlinked });
    flushSync();
    const buttons = target.querySelectorAll<HTMLButtonElement>(".linkify");
    expect(buttons).toHaveLength(1);
    buttons[0]!.click();
    expect(onLinkify).toHaveBeenCalledWith(unlinked[0]);
  });
});
