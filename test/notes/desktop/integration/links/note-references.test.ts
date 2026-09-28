/** @vitest-environment jsdom */
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import BacklinksPane from "@reader/renderer/links/BacklinksPane.svelte";
import type { MentionRecord, Mentions } from "../../../../../modules/notes/packages/desktop/src/features/reader/shared/api";

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

describe("正文末尾的引用", () => {
  it("按来源笔记计数，默认收起，并保留每次出现的跳转", () => {
    const linked = [mention("来源甲.md", 0), mention("来源甲.md", 12), mention("来源乙.md", 0)];
    const { target, onOpen } = start({ linked, unlinked: [] });
    const details = target.querySelector("details")!;
    expect(details.querySelector("summary")?.textContent).toContain("被 2 篇笔记引用");
    expect(details.open).toBe(false);
    expect(target.querySelector("select")).toBeNull();
    expect(target.querySelector('input[role="searchbox"]')).toBeNull();
    details.open = true;
    const hits = target.querySelectorAll<HTMLButtonElement>(".hit");
    expect(hits).toHaveLength(3);
    hits[1]!.click();
    expect(onOpen).toHaveBeenCalledWith(linked[1]);
  });

  it("候选提及单独标注，不计为已经引用的笔记", () => {
    const { target } = start({ linked: [], unlinked: [mention("来源.md", 0, "unlinked")] });
    expect(target.textContent).toContain("可能相关的提及");
    expect(target.textContent).not.toContain("被 1 篇笔记引用");
    expect(target.querySelector("details")?.open).toBe(false);
  });

  it("没有关联时不展示空面板", () => {
    const { target } = start({ linked: [], unlinked: [] });
    expect(target.querySelector("section")).toBeNull();
    expect(target.textContent?.trim()).toBe("");
  });

  it("只有未链接提及带「转为链接」动作，点击回传整条提及", () => {
    const linked = [mention("来源甲.md", 0)];
    const unlinked = [mention("来源乙.md", 40, "unlinked")];
    const { target, onLinkify } = start({ linked, unlinked });
    const details = target.querySelectorAll("details");
    for (const detail of details) detail.open = true;
    flushSync();
    const buttons = target.querySelectorAll<HTMLButtonElement>(".linkify");
    expect(buttons).toHaveLength(1);
    buttons[0]!.click();
    expect(onLinkify).toHaveBeenCalledWith(unlinked[0]);
  });
});
