import { computeExport } from "@reader/main/export/computation";
import { describe, expect, it, vi } from "vitest";
import { ExportResources } from "@reader/main/export/resources";
import type { ExportRenderer } from "@reader/main/export/render";
import { nativeExportFixture } from "../../support/export-native";

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>';
function renderer(): ExportRenderer {
  return {
    render: vi.fn<ExportRenderer["render"]>(async (request) => {
      if (request.kind !== "image") throw new Error("冻结下载不应提前转换");
      return { kind: "image", data: request.source, width: 1, height: 1 };
    }),
    pdf: async () => {
      throw new Error("不应打印");
    },
  };
}

describe("EXP-NETWORK 有界并发、磁盘冻结和资源去重", () => {
  it("同时下载四项，重复 URL 只请求一次，同内容不同 URL 只计一个源资源", async (t) => {
    const fixture = await nativeExportFixture(t, { "a.md": "正文" }, "markdown");
    const render = renderer();
    const resources = new ExportResources(
      fixture.native,
      render,
      new AbortController().signal,
      computeExport,
    );
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let active = 0,
      maximum = 0;
    const fetch = vi.fn(async () => {
      maximum = Math.max(maximum, ++active);
      await gate;
      active--;
      return new Response(svg, { headers: { "content-type": "image/svg+xml" } });
    });
    vi.stubGlobal("fetch", fetch);
    t.onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    const urls = Array.from({ length: 8 }, (_, i) => `https://images.test/${i}.svg`);
    const pending = resources.prefetchImages([...urls, ...urls]);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
    expect(active).toBe(4);
    expect(render.render).not.toHaveBeenCalled();
    release();
    await pending;
    expect(maximum).toBe(4);
    expect(fetch).toHaveBeenCalledTimes(8);
    for (const url of urls) await resources.image(url);
    expect(fetch).toHaveBeenCalledTimes(8);
    await fixture.native.seal();
    expect(fixture.native.snapshot.resources).toBe(1);
    expect(fixture.native.snapshot.resourceBytes).toBe(Buffer.byteLength(svg));
    expect(resources.downloads).toHaveLength(8);
    expect(new Set(resources.downloads.map((entry) => entry.path)).size).toBe(1);
  });

  it("取消中止正在下载的四项，队列余项不启动，所有异步任务都已结束", async (t) => {
    const fixture = await nativeExportFixture(t, { "a.md": "正文" }, "markdown");
    const controller = new AbortController();
    const resources = new ExportResources(
      fixture.native,
      renderer(),
      controller.signal,
      computeExport,
    );
    let active = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, options) => {
      active++;
      try {
        await new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new Error("cancelled download")),
            { once: true },
          );
        });
        throw new Error("不得正常结束");
      } finally {
        active--;
      }
    });
    vi.stubGlobal("fetch", fetch);
    t.onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    const pending = resources.prefetchImages(
      Array.from({ length: 20 }, (_, i) => `https://images.test/${i}.png`),
    );
    const assertion = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
    controller.abort();
    await assertion;
    expect(active).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});
