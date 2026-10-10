import { beforeEach, expect, it, vi } from "vitest";
import { renderMermaid } from "@reader/renderer/markdown/views/mermaid";

const engine = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock("mermaid", () => ({
  default: {
    initialize: engine.initialize,
    render: engine.render,
    mermaidAPI: { defaultConfig: { secure: ["securityLevel", "secure"] } },
  },
}));

beforeEach(() => {
  engine.initialize.mockReset();
  engine.render.mockReset().mockResolvedValue({ svg: "<svg></svg>" });
});

it("并发消息按各自主题排版，初始化不会越过正在渲染的图表", async () => {
  const first = Promise.withResolvers<{ svg: string }>();
  engine.render.mockReturnValueOnce(first.promise);
  const light = renderMermaid("light", "flowchart TD\nA-->B", false);
  const dark = renderMermaid("dark", 'pie\n"A": 1', true);
  await vi.waitFor(() => expect(engine.render).toHaveBeenCalledTimes(1));
  expect(engine.initialize).toHaveBeenCalledTimes(1);
  expect(engine.initialize).toHaveBeenLastCalledWith(
    expect.objectContaining({
      theme: "neutral",
      securityLevel: "strict",
      suppressErrorRendering: true,
    }),
  );
  first.resolve({ svg: "<svg>light</svg>" });
  expect(await light).toBe("<svg>light</svg>");
  await dark;
  expect(engine.initialize).toHaveBeenLastCalledWith(expect.objectContaining({ theme: "dark" }));
  expect(engine.render).toHaveBeenLastCalledWith("dark", 'pie\n"A": 1');
});

it("语法失败由当前调用接收，队列继续渲染其他图表", async () => {
  engine.render.mockRejectedValueOnce(new Error("语法错误"));
  const invalid = renderMermaid("invalid", "invalid", false);
  const valid = renderMermaid("valid", "sequenceDiagram\nA->>B: Hello", false);
  await expect(invalid).rejects.toThrow("语法错误");
  await expect(valid).resolves.toBe("<svg></svg>");
  expect(engine.render).toHaveBeenCalledTimes(2);
});

it("排队时取消的图表跳过初始化和布局，下一张有效图表继续执行", async () => {
  const first = Promise.withResolvers<{ svg: string }>();
  engine.render.mockReturnValueOnce(first.promise);
  const busy = renderMermaid("busy", "flowchart TD\nA-->B", false);
  await vi.waitFor(() => expect(engine.render).toHaveBeenCalledOnce());
  const controller = new AbortController();
  const stale = renderMermaid("stale", "flowchart TD\nC-->D", false, controller.signal);
  const failure = expect(stale).rejects.toMatchObject({ name: "AbortError" });
  const current = renderMermaid("current", "flowchart TD\nE-->F", true);
  controller.abort();
  first.resolve({ svg: "<svg>first</svg>" });
  await Promise.all([busy, current, failure]);
  expect(engine.render.mock.calls.map(([id]) => id)).toEqual(["busy", "current"]);
  expect(engine.initialize).toHaveBeenCalledTimes(2);
});
