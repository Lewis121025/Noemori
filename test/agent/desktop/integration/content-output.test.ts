/** @vitest-environment jsdom */
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ToolMessage from "../../../../modules/notes/packages/desktop/src/features/agent/renderer/ToolMessage.svelte";
import { createAgentApiMock } from "../../../notes/desktop/fixtures/agent-api-mock";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";

beforeEach(() => {
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL() {
        return "blob:tool-image";
      }
      static revokeObjectURL() {}
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

it("工具展开后展示原生图片，收起不丢失文字结果和调用身份", async () => {
  const target = document.createElement("div");
  document.body.append(target);
  const view = mount(ToolMessage, {
    target,
    props: {
      running: false,
      call: { id: "shot", name: "browser", arguments: { action: "screenshot" } },
      result: {
        call_id: "shot",
        name: "browser",
        output: "截图已生成",
        is_error: false,
        media: [{ type: "image", value: { format: "png", data: png } }],
      },
    },
  });
  try {
    flushSync();
    expect(target.querySelector(".content-card")).toBeNull();
    target.querySelector<HTMLElement>(".tool-card > summary")!.click();
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector('[aria-label="内容：图片.png"]')).not.toBeNull();
    });
    expect(target.querySelector(".tool-output pre")?.textContent).toBe("截图已生成");
    target.querySelector<HTMLElement>(".tool-card > summary")!.click();
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector(".content-card")).toBeNull();
    });
    expect(target.querySelector(".tool-output pre")?.textContent).toBe("截图已生成");
  } finally {
    await unmount(view);
    target.remove();
  }
});

it("成功读取的 HTML 按字面路径预览，失败提示可重试，原始输出始终可查", async () => {
  const target = document.createElement("div");
  document.body.append(target);
  const api = {
    ...createAgentApiMock(),
    contentPreview: vi
      .fn()
      .mockRejectedValueOnce(new Error("文件暂时无法读取"))
      .mockResolvedValueOnce({
        name: "页面#稿?.html",
        bytes: new TextEncoder().encode("<h1>预览</h1>"),
        preview: { type: "html", text: "<h1>预览</h1>" },
      }),
  };
  const view = mount(ToolMessage, {
    target,
    props: {
      api,
      session: "current",
      running: false,
      call: {
        id: "read",
        name: "terminal",
        arguments: { action: "exec", cmd: "cat '页面#稿?.html'" },
      },
      result: {
        call_id: "read",
        name: "terminal",
        output: { output: "<h1>原文</h1>", status: "exited", exit_code: 0 },
        is_error: false,
      },
    },
  });
  try {
    flushSync();
    expect(api.contentPreview).not.toHaveBeenCalled();
    target.querySelector<HTMLElement>(".tool-card > summary")!.click();
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector('[role="alert"]')?.textContent).toContain("文件暂时无法读取");
    });
    expect(api.contentPreview).toHaveBeenCalledWith(
      "current",
      "%E9%A1%B5%E9%9D%A2%23%E7%A8%BF%3F.html",
    );
    [...target.querySelectorAll("button")].find((button) => button.textContent === "重试")!.click();
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector("iframe")?.srcdoc).toContain("<h1>预览</h1>");
    });
    expect(target.querySelector('[role="alert"]')).toBeNull();
    expect(target.querySelector(".tool-meta")?.textContent).toContain("<h1>原文</h1>");
  } finally {
    await unmount(view);
    target.remove();
  }
});
