/** @vitest-environment jsdom */
import { flushSync } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReaderWorkspaceController } from "@reader/renderer/workspace/state.svelte";
import type { LinkTarget, MentionRecord, ReaderApi } from "@reader/shared/api";
import { createReaderApiMock } from "../../fixtures/reader-api-mock";

const mentionRecord: MentionRecord = {
  fromPath: "a/foo.md",
  fromTitle: "A",
  mtime: 1,
  startByte: 7,
  endByte: 13,
  snippet: "开头 目标 结尾",
  kind: "unlinked",
  linkKind: null,
  toRaw: "目标",
};

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function createApi(resolveResult: LinkTarget, overrides: Partial<ReaderApi> = {}): ReaderApi {
  return createReaderApiMock({
    vaultEntries: vi.fn(async () => [
      { path: "a/foo.md", kind: "file" as const },
      { path: "b/foo.md", kind: "file" as const },
      { path: "ref.md", kind: "file" as const },
    ]),
    fileSnapshot: vi.fn(async () => ({
      disk: encode("# 笔记\n\n## 小节\n\n正文。\n"),
      draft: null,
    })),
    linksResolve: vi.fn(async () => resolveResult),
    ...overrides,
  });
}

async function startWorkspace(api: ReaderApi): Promise<ReaderWorkspaceController> {
  const workspace = new ReaderWorkspaceController(api);
  await workspace.restore();
  await workspace.openFile("ref.md");
  flushSync();
  return workspace;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("链接跳转的解析分支", () => {
  it("预览链接按内容所属笔记解析，死链创建也保留同一目录", async () => {
    const api = createApi({ status: "dead" });
    const workspace = await startWorkspace(api);
    await workspace.openLink("md", "./missing.md#小节", "notes/资料.md");
    expect(api.linksResolve).toHaveBeenCalledWith("notes/资料.md", "./missing.md#小节", "md");
    expect(workspace.deadLinkOffer).toEqual({ path: "notes/missing.md", anchor: "小节" });
    expect(workspace.document.path).toBe("ref.md");
  });

  it("预览解析迟到时不跳转到已经离开的宿主文档", async () => {
    let finish!: (value: LinkTarget) => void;
    const api = createApi(
      { status: "dead" },
      {
        linksResolve: vi.fn(
          () =>
            new Promise<LinkTarget>((resolve) => {
              finish = resolve;
            }),
        ),
      },
    );
    const workspace = await startWorkspace(api);
    const pending = workspace.openLink("md", "./target.md", "notes/资料.md");
    await workspace.openFile("a/foo.md");
    finish({ status: "resolved", path: "notes/target.md", anchor: null });
    await pending;
    expect(workspace.document.path).toBe("a/foo.md");
  });
  it("可创建的死链等待确认，纯锚点只提示无法跳转", async () => {
    const workspace = await startWorkspace(createApi({ status: "dead" }));
    await workspace.openLink("wiki", "missing#小节");
    expect(workspace.deadLinkOffer).toEqual({ path: "missing.md", anchor: "小节" });
    expect(workspace.document.path).toBe("ref.md");
    workspace.dismissDeadLink();
    expect(workspace.deadLinkOffer).toBeNull();

    await workspace.openLink("wiki", "#");
    expect(workspace.message).toContain("死链");
    expect(workspace.deadLinkOffer).toBeNull();
  });

  it("确认死链后创建笔记并打开", async () => {
    const api = createApi({ status: "dead" });
    const workspace = await startWorkspace(api);
    await workspace.openLink("wiki", "missing");
    await workspace.confirmDeadLink();
    await settle();
    // 无锚点的死链不种初始内容。
    expect(api.entryCreate).toHaveBeenCalledWith("missing.md", "file", undefined);
    expect(workspace.document.path).toBe("missing.md");
    expect(workspace.deadLinkOffer).toBeNull();
  });

  it("歧义候选等待用户选择，选中后打开并清空候选", async () => {
    const workspace = await startWorkspace(
      createApi({
        status: "ambiguous",
        candidates: ["a/foo.md", "b/foo.md"],
        anchor: null,
      }),
    );
    await workspace.openLink("wiki", "foo");
    expect(workspace.document.path).toBe("ref.md");
    expect(workspace.linkCandidates).toEqual({
      paths: ["a/foo.md", "b/foo.md"],
      anchor: null,
    });

    await workspace.chooseLinkCandidate("b/foo.md");
    await settle();
    expect(workspace.document.path).toBe("b/foo.md");
    expect(workspace.linkCandidates).toBeNull();
  });

  it("放弃候选选择不打开任何目标", async () => {
    const workspace = await startWorkspace(
      createApi({ status: "ambiguous", candidates: ["a/foo.md", "b/foo.md"], anchor: null }),
    );
    await workspace.openLink("wiki", "foo");
    workspace.dismissLinkCandidates();
    expect(workspace.linkCandidates).toBeNull();
    expect(workspace.document.path).toBe("ref.md");
  });

  it("跨文件锚点打开目标文件；编辑器缺席时定位留待挂载兑现", async () => {
    const workspace = await startWorkspace(
      createApi({ status: "resolved", path: "a/foo.md", anchor: "小节" }),
    );
    await workspace.openLink("wiki", "a/foo#小节");
    await settle();
    expect(workspace.document.path).toBe("a/foo.md");
    // 无编辑器可定位时不得崩溃，也不误报锚点失效（失效提示属于编辑器验证）。
    expect(workspace.message).not.toContain("未找到标题");
  });

  it("同文档锚点没有编辑器可验证时给出可见的失效提示", async () => {
    const workspace = await startWorkspace(
      createApi({ status: "resolved", path: "ref.md", anchor: "小节" }),
    );
    await workspace.openLink("wiki", "#小节");
    expect(workspace.document.path).toBe("ref.md");
    expect(workspace.message).toContain("未找到标题");
  });

  it("无锚点的唯一解析直接打开文件", async () => {
    const workspace = await startWorkspace(
      createApi({ status: "resolved", path: "a/foo.md", anchor: null }),
    );
    await workspace.openLink("wiki", "a/foo");
    await settle();
    expect(workspace.document.path).toBe("a/foo.md");
    expect(workspace.message).not.toContain("未找到标题");
  });

  it("死链创建把 # 标题锚点随创建事务写入，再挂起定位", async () => {
    const entryCreate = vi.fn(async () => ({ warning: null }));
    const workspace = await startWorkspace(createApi({ status: "dead" }, { entryCreate }));
    await workspace.openLink("wiki", "new-note#计划");
    expect(workspace.deadLinkOffer).toEqual({ path: "new-note.md", anchor: "计划" });

    await workspace.confirmDeadLink();
    await settle();

    // 种子内容与创建是同一次独占提交，磁盘上没有空文件中间态。
    expect(entryCreate).toHaveBeenCalledWith(
      "new-note.md",
      "file",
      new TextEncoder().encode("# 计划\n\n"),
    );
    expect(workspace.document.path).toBe("new-note.md");
    // 无编辑器可定位：挂起等待挂载兑现，不得误报锚点失效。
    expect(workspace.message).not.toContain("未找到标题");
    expect(workspace.deadLinkOffer).toBeNull();
  });

  it("放弃死链创建不写任何文件", async () => {
    const entryCreate = vi.fn(async () => ({ warning: null }));
    const workspace = await startWorkspace(createApi({ status: "dead" }, { entryCreate }));
    await workspace.openLink("wiki", "new-note#计划");
    workspace.dismissDeadLink();
    expect(workspace.deadLinkOffer).toBeNull();
    expect(entryCreate).not.toHaveBeenCalled();
    expect(workspace.document.path).toBe("ref.md");
  });
});

describe("未链接提及转链接", () => {
  it("按区间与期望文本交给内核改写，成功后确认并刷新引用", async () => {
    const mentionsLinkify = vi.fn(async () => ({ warning: null }));
    const workspace = await startWorkspace(
      createApi({ status: "dead" }, { mentionsLinkify }),
    );
    await workspace.linkifyMention(mentionRecord, "ref.md");
    expect(mentionsLinkify).toHaveBeenCalledWith("a/foo.md", 7, 13, "目标", "ref.md");
    expect(workspace.message).toContain("已把「目标」转为链接");
  });

  it("内核拒绝（区间过期）时如实报告，不伪装成功", async () => {
    const mentionsLinkify = vi.fn(async (): Promise<{ warning: string | null }> => {
      throw new Error("文件已被外部修改: a/foo.md");
    });
    const workspace = await startWorkspace(
      createApi({ status: "dead" }, { mentionsLinkify }),
    );
    await workspace.linkifyMention(mentionRecord, "ref.md");
    expect(workspace.message).toContain("转为链接失败");
    expect(workspace.message).toContain("文件已被外部修改");
    expect(workspace.messageNeedsAttention).toBe(true);
  });

  it("提交后的索引警告并入提示，不当作失败", async () => {
    const mentionsLinkify = vi.fn(async () => ({ warning: "索引刷新失败：磁盘忙" }));
    const workspace = await startWorkspace(
      createApi({ status: "dead" }, { mentionsLinkify }),
    );
    await workspace.linkifyMention(mentionRecord, "ref.md");
    expect(workspace.message).toContain("已转为链接");
    expect(workspace.message).toContain("索引刷新失败");
  });
});
