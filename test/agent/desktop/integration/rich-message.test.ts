/** @vitest-environment jsdom */
import { flushSync, mount, unmount } from "svelte";
import { fromStore, writable } from "svelte/store";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import MessageText from "../../../../modules/notes/packages/desktop/src/features/agent/renderer/MessageText.svelte";

const renderers = vi.hoisted(() => ({ diagram: vi.fn(), math: vi.fn() }));
vi.mock(
  "../../../../modules/notes/packages/desktop/src/features/reader/renderer/previews",
  async (original) => ({
    ...(await original<object>()),
    renderMermaid: renderers.diagram,
    renderTex: renderers.math,
  }),
);

const cleanup: Array<() => Promise<void>> = [];
beforeEach(() => {
  renderers.diagram
    .mockReset()
    .mockResolvedValue(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><text>图表</text></svg>',
    );
  renderers.math.mockReset().mockImplementation(async (tex: string) => {
    const node = document.createElement("mjx-container");
    node.textContent = tex;
    return node;
  });
});
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
  vi.restoreAllMocks();
});

function render(text: string) {
  const target = document.createElement("div");
  document.body.append(target);
  const store = writable(text),
    state = fromStore(store);
  const openLink = vi.fn(async () => {});
  const component = mount(MessageText, {
    target,
    props: {
      get text() {
        return state.current;
      },
      openLink,
    },
  });
  const dispose = async () => {
    await unmount(component);
    target.remove();
  };
  cleanup.push(dispose);
  flushSync();
  return { target, store, openLink };
}

function button(target: HTMLElement, label: string): HTMLButtonElement {
  const found = [...target.querySelectorAll("button")].find(
    (item) => item.getAttribute("aria-label") === label,
  );
  expect(found, label).toBeDefined();
  return found!;
}

it("Mermaid 默认显示隔离的图表，可切换源码并保留复制入口", async () => {
  const source = "sequenceDiagram\nA->>B: 你好";
  const { target } = render(`\`\`\`Mermaid\n${source}\n\`\`\``);
  await vi.waitFor(() => {
    flushSync();
    expect(
      target.querySelector<HTMLIFrameElement>('iframe[title="Mermaid 图表"]')?.srcdoc,
    ).toContain("<svg");
  });
  expect(renderers.diagram).toHaveBeenCalledWith(
    expect.any(String),
    source,
    false,
    expect.any(AbortSignal),
  );
  const frame = target.querySelector("iframe")!;
  expect(frame.getAttribute("sandbox")).toBe("");
  expect(frame.srcdoc).toContain("default-src 'none'");
  expect(target.querySelector(".mermaid-content")?.textContent?.trim()).toBe("");
  button(target, "源码").click();
  flushSync();
  expect(target.querySelector("pre code")?.textContent).toBe(source);
  expect(target.querySelector('[aria-label="复制代码"]')).not.toBeNull();
});

it("图表语法错误保留原文，流式补全后恢复预览", async () => {
  renderers.diagram.mockRejectedValueOnce(new Error("缺少节点"));
  const { target, store } = render("```mermaid\nflowchart TD\nA-->");
  await vi.waitFor(() => {
    flushSync();
    expect(target.querySelector(".preview-issue")?.textContent).toContain("缺少节点");
  });
  expect(target.querySelector<HTMLDetailsElement>(".preview-issue")?.open).toBe(false);
  expect(target.querySelector("pre code")).toBeNull();
  button(target, "源码").click();
  flushSync();
  expect(target.querySelector("pre code")?.textContent).toContain("A-->");
  button(target, "预览").click();
  flushSync();
  store.set("```mermaid\nflowchart TD\nA-->B\n```");
  flushSync();
  await vi.waitFor(() => {
    flushSync();
    expect(target.querySelector("iframe")).not.toBeNull();
  });
  expect(target.textContent).not.toContain("缺少节点");
});

it("过期图表和公式排版不能覆盖新消息，卸载后也不能重新插入内容", async () => {
  const diagram = Promise.withResolvers<string>();
  const math = Promise.withResolvers<HTMLElement>();
  renderers.diagram.mockReturnValueOnce(diagram.promise);
  renderers.math.mockReturnValueOnce(math.promise);
  const { target, store } = render("$old$\n\n```mermaid\nflowchart TD\nA-->B\n```");
  await vi.waitFor(() => expect(renderers.diagram).toHaveBeenCalledOnce());
  store.set("$new$\n\n```mermaid\nflowchart TD\nC-->D\n```");
  flushSync();
  await vi.waitFor(() => expect(renderers.diagram).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => {
    flushSync();
    expect(target.querySelector("mjx-container")?.textContent).toBe("new");
  });
  diagram.resolve("<svg><text>过期图表</text></svg>");
  const old = document.createElement("mjx-container");
  old.textContent = "old";
  math.resolve(old);
  await Promise.all([diagram.promise, math.promise]);
  flushSync();
  expect(target.querySelector("iframe")?.srcdoc).not.toContain("过期图表");
  expect(target.querySelector("mjx-container")?.textContent).toBe("new");
  const pending = Promise.withResolvers<string>();
  renderers.diagram.mockReturnValueOnce(pending.promise);
  store.set("```mermaid\nflowchart TD\nE-->F\n```");
  flushSync();
  await vi.waitFor(() => expect(renderers.diagram).toHaveBeenCalledTimes(3));
  await cleanup.pop()!();
  pending.resolve("<svg></svg>");
  await pending.promise;
  flushSync();
  expect(target.childElementCount).toBe(0);
});

it("行内与块级公式使用相应排版，代码内的美元符号保持原文", async () => {
  const { target } = render("正文 $E=mc^2$\n\n$$\n\\frac{1}{2}\n$$\n\n`$literal$`");
  await vi.waitFor(() => {
    flushSync();
    expect(target.querySelectorAll("mjx-container")).toHaveLength(2);
  });
  expect(renderers.math).toHaveBeenCalledWith("E=mc^2", false);
  expect(renderers.math).toHaveBeenCalledWith("\\frac{1}{2}", true);
  expect(target.querySelector("code")?.textContent).toBe("$literal$");
});

it("引用式链接、图片及邮件链接保留地址与标题，定义不作为正文出现", async () => {
  const { target, openLink } = render(
    '[文档][DOC]\n\n![示意][pic]\n\n<dev@example.com>\n\n[doc]: https://example.com/docs "资料标题"\n[pic]: https://example.com/chart.png',
  );
  const link = target.querySelector<HTMLAnchorElement>('a[href="https://example.com/docs"]');
  expect(link?.textContent).toBe("文档");
  expect(link?.title).toBe("资料标题");
  link!.click();
  await vi.waitFor(() => expect(openLink).toHaveBeenCalledWith("https://example.com/docs"));
  expect(target.querySelector('a[href="mailto:dev@example.com"]')).not.toBeNull();
  expect(target.querySelector('[aria-label="内容：示意"]')).not.toBeNull();
  expect(target.querySelector("img")).toBeNull();
  expect(target.textContent).not.toContain("[doc]:");
});

it("脚注按引用顺序编号，多次引用可逐一返回，消息之间的锚点不冲突", () => {
  const source = "先[^b] 再[^a] 又[^b]。\n\n[^a]: 注释甲\n[^b]: 注释乙\n[^unused]: 未引用";
  const first = render(source).target;
  const second = render(source).target;
  expect([...first.querySelectorAll("sup a")].map((node) => node.textContent)).toEqual([
    "1",
    "2",
    "1",
  ]);
  expect(
    [...first.querySelectorAll('[aria-label="脚注"] li')].map((node) => node.textContent),
  ).toEqual([expect.stringContaining("注释乙"), expect.stringContaining("注释甲")]);
  expect(first.textContent).not.toContain("未引用");
  const ids = [...first.querySelectorAll("[id]"), ...second.querySelectorAll("[id]")].map(
    (node) => node.id,
  );
  expect(new Set(ids).size).toBe(ids.length);
  for (const link of first.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')) {
    expect(first.querySelector(`[id="${link.hash.slice(1)}"]`)).not.toBeNull();
  }
});

it("表格对齐、高亮、注释与受控行内样式保持 Markdown 语义", () => {
  const { target } = render(
    "| 左 | 中 | 右 |\n| :--- | :---: | ---: |\n| A | B | C |\n\n==重点== %%隐藏说明%% <u>下划线</u>\n\n正文<br>换行",
  );
  expect(
    [...target.querySelectorAll("thead th")].map((cell) => (cell as HTMLElement).style.textAlign),
  ).toEqual(["left", "center", "right"]);
  expect(
    [...target.querySelectorAll("tbody td")].map((cell) => (cell as HTMLElement).style.textAlign),
  ).toEqual(["left", "center", "right"]);
  expect(target.querySelector("mark")?.textContent).toBe("重点");
  expect(target.querySelector("u")?.textContent).toBe("下划线");
  expect(target.textContent).not.toContain("隐藏说明");
  expect(target.querySelector("br")).not.toBeNull();
});

it("引用定义中的危险协议也不会成为可点击链接或触发文件读取", () => {
  const { target, openLink } = render("[保留文字][bad]\n\n[bad]: javascript:alert(1)");
  expect(target.textContent).toContain("保留文字");
  expect(target.querySelector("a")).toBeNull();
  expect(openLink).not.toHaveBeenCalled();
});

it("链接先按协议分类，邮件和不支持的协议不因扩展名被当作文件预览", () => {
  const { target } = render(
    "[邮件](mailto:report.pdf)\n\n[无效地址](javascript:report.png)\n\n![图片说明](javascript:image.png)",
  );
  expect(target.querySelector('a[href="mailto:report.pdf"]')?.textContent).toBe("邮件");
  expect(target.querySelector(".content-card")).toBeNull();
  expect(target.textContent).toContain("无效地址");
  expect(target.textContent).toContain("图片说明");
});

it("标题锚点只按正文和实际显示的脚注编号，隐藏定义不占用锚点", () => {
  const { target, openLink } = render(
    "[^unused]: # Topic\n\n[^shown]: # Topic\n\n# Topic\n\n# Topic\n\n[正文](#topic) [第二处](#topic-1) 引用[^shown]",
  );
  const headings = [...target.querySelectorAll("h1")];
  expect(headings.map((heading) => heading.id.slice(heading.id.indexOf("-heading-") + 9))).toEqual([
    "topic",
    "topic-1",
    "topic-2",
  ]);
  const link = [...target.querySelectorAll<HTMLAnchorElement>("a")].find(
    (item) => item.textContent === "正文",
  )!;
  link.click();
  expect(document.activeElement).toBe(headings[0]);
  expect(openLink).not.toHaveBeenCalled();
});

it("替换消息会取消已交给图表队列的旧任务，卸载取消最后一项", async () => {
  const { store } = render("```mermaid\nflowchart TD\nA-->B\n```");
  await vi.waitFor(() => expect(renderers.diagram).toHaveBeenCalledOnce());
  const signal: AbortSignal | undefined = renderers.diagram.mock.calls[0]?.[3];
  store.set("```mermaid\nflowchart TD\nC-->D\n```");
  flushSync();
  expect(signal?.aborted).toBe(true);
  await vi.waitFor(() => expect(renderers.diagram).toHaveBeenCalledTimes(2));
  const current: AbortSignal | undefined = renderers.diagram.mock.calls[1]?.[3];
  await cleanup.pop()!();
  expect(current?.aborted).toBe(true);
});
