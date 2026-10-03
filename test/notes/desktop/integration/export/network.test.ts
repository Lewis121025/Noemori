import { createServer } from "node:http";
import { describe, expect, it, vi, type TestContext } from "vitest";
import { downloadImage } from "@reader/main/export/resources";
import { EXPORT_LIMITS } from "@reader/shared/export";
import { getEventListeners } from "node:events";
import { createHook } from "node:async_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";

async function server(t: TestContext): Promise<string> {
  const value = createServer((request, response) => {
    const path = request.url ?? "";
    if (path === "/ok") {
      response.writeHead(200, { "content-type": "image/svg+xml" });
      response.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
    } else if (path === "/mime") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("error page");
    } else if (path === "/empty") {
      response.writeHead(200, { "content-type": "image/png" });
      response.end();
    } else if (path === "/abort") {
      response.writeHead(200, { "content-type": "image/png" });
      response.write("start");
    } else if (path.startsWith("/redirect/")) {
      const count = Number(path.slice("/redirect/".length));
      response.writeHead(302, { location: count > 1 ? `/redirect/${count - 1}` : "/ok" });
      response.end();
    } else {
      response.writeHead(Number(path.slice(1)) || 404);
      response.end();
    }
  });
  t.onTestFinished(async () => {
    value.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      value.close((error) => (error ? reject(error) : resolve())),
    );
  });
  await new Promise<void>((resolve) => value.listen(0, "127.0.0.1", resolve));
  const address = value.address();
  if (address === null || typeof address === "string") throw new Error("测试服务器地址无效");
  return `http://127.0.0.1:${address.port}`;
}

describe("网络图片冻结的失败边界", () => {
  it("响应完成后不能遗留尚待触发的原生超时定时器", async (t) => {
    const timers = new Set<number>();
    const hook = createHook({
      init(id, type) {
        if (type === "Timeout") timers.add(id);
      },
      destroy(id) {
        timers.delete(id);
      },
    });
    t.onTestFinished(() => {
      hook.disable();
      vi.unstubAllGlobals();
    });
    vi.stubGlobal(
      "fetch",
      async () => new Response("image", { headers: { "content-type": "image/png" } }),
    );
    hook.enable();
    await downloadImage("https://images.test/resource", new AbortController().signal);
    hook.disable();
    // 只观察本次下载创建的资源；重新启用 destroy 通知，清理回调在下一轮事件循环到达。
    const cleanup = createHook({
      destroy(id) {
        timers.delete(id);
      },
    });
    cleanup.enable();
    try {
      await nextTurn();
      expect(timers.size).toBe(0);
    } finally {
      cleanup.disable();
    }
  });
  it("成功、取消与超时都立即清理自己的计时器和取消订阅", async (t) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    t.onTestFinished(() => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });
    for (const outcome of ["success", "cancel", "timeout"]) {
      const parent = new AbortController();
      vi.stubGlobal("fetch", (_url: URL, options: RequestInit) => {
        if (outcome === "success")
          return Promise.resolve(
            new Response("image", { headers: { "content-type": "image/png" } }),
          );
        return new Promise<Response>((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
            once: true,
          });
        });
      });
      const pending = downloadImage("https://images.test/resource", parent.signal);
      const assertion =
        outcome === "success"
          ? expect(pending).resolves.toMatchObject({ mime: "image/png" })
          : expect(pending).rejects.toThrow();
      if (outcome === "cancel") parent.abort(new Error("controlled cancellation"));
      if (outcome === "timeout") await vi.advanceTimersByTimeAsync(EXPORT_LIMITS.downloadMs);
      await assertion;
      expect(vi.getTimerCount()).toBe(0);
      expect(getEventListeners(parent.signal, "abort")).toEqual([]);
    }
  });
  it("允许五次重定向，第六次拒绝；最终内容和 MIME 属于同一响应", async (t) => {
    const base = await server(t);
    const result = await downloadImage(`${base}/redirect/5`, new AbortController().signal);
    expect(result.mime).toBe("image/svg+xml");
    expect(new TextDecoder().decode(result.bytes)).toContain("<svg ");
    await expect(downloadImage(`${base}/redirect/6`, new AbortController().signal)).rejects.toThrow(
      "重定向次数",
    );
  });
  it.for(["403", "404", "500", "mime", "empty"])(
    "不可用响应 %s 不会被当作成功资源",
    async (path, t) => {
      const base = await server(t);
      await expect(
        downloadImage(`${base}/${path}`, new AbortController().signal),
      ).rejects.toThrow();
    },
  );
  it("流未结束时取消能够关闭读取，凭据和非 HTTP 地址被拒绝", async (t) => {
    const base = await server(t);
    const controller = new AbortController();
    const pending = downloadImage(`${base}/abort`, controller.signal);
    const assertion = expect(pending).rejects.toThrow();
    controller.abort();
    await assertion;
    await expect(
      downloadImage("https://name:password@example.test/image.png", new AbortController().signal),
    ).rejects.toThrow("不受支持");
    await expect(
      downloadImage("file:///tmp/image.png", new AbortController().signal),
    ).rejects.toThrow("不受支持");
  });
  it("按实际流字节执行 64 MiB 上限，不信任缺失或错误 Content-Length", async (t) => {
    t.onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    for (const extra of [0, 1]) {
      let remaining = EXPORT_LIMITS.resourceBytes + extra;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!remaining) {
            controller.close();
            return;
          }
          const size = Math.min(remaining, 1024 * 1024);
          remaining -= size;
          controller.enqueue(new Uint8Array(size));
        },
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(body, { headers: { "content-type": "image/png", "content-length": "1" } }),
        ),
      );
      const pending = downloadImage("https://image.test/test", new AbortController().signal);
      if (extra) await expect(pending).rejects.toThrow("64 MiB");
      else expect((await pending).bytes.byteLength).toBe(EXPORT_LIMITS.resourceBytes);
    }
  });
});
