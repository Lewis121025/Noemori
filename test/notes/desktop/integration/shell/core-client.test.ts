import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoreClient } from "../../../../../modules/notes/packages/desktop/src/main/core-client";

const workers: Worker[] = [];

function start(mode = "normal") {
  const gate = new Int32Array(new SharedArrayBuffer(8));
  const worker = new Worker(
    `
      const { parentPort, workerData } = require("node:worker_threads");
      let count = 0;
      parentPort.on("message", (request) => {
        if (request.type === "shutdown") {
          if (workerData.mode === "exit-on-stop") process.exit(0);
          parentPort.postMessage({ type: "stopped" });
          parentPort.close();
          return;
        }
        if (workerData.mode === "crash") throw new Error("测试线程故障");
        if (workerData.mode === "exit") process.exit(0);
        if (request.command === "fileRead") {
          Atomics.store(workerData.gate, 0, 1);
          Atomics.wait(workerData.gate, 1, 0, 3000);
          parentPort.postMessage({ type: "result", id: request.id, value: new Uint8Array([42]) });
        } else if (request.command === "entryRename") {
          parentPort.postMessage({ type: "error", id: request.id, message: "目标已存在：b.md" });
        } else {
          parentPort.postMessage({ type: "result", id: request.id, value: [String(++count)] });
        }
      });
    `,
    { eval: true, workerData: { mode, gate } },
  );
  workers.push(worker);
  const changed = vi.fn();
  return { client: new CoreClient(worker, changed), worker, gate, changed };
}

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.terminate()));
});

describe("core client with a real worker thread", () => {
  it("waits for the exit event even when the worker has already reported an error", async () => {
    const { client, worker, changed } = start("crash");
    let exited = false;
    worker.once("exit", () => {
      exited = true;
    });
    const failedCall = expect(client.call("vaultList")).rejects.toThrow("测试线程故障");
    await expect(client.shutdown()).rejects.toThrow("测试线程故障");
    expect(exited).toBe(true);
    expect(changed).toHaveBeenCalledExactlyOnceWith({ status: "worker-error", paths: [], message: "测试线程故障" });
    await failedCall;
  });

  it("requires confirmation that the native service was closed before treating exit as success", async () => {
    const { client } = start("exit-on-stop");
    await client.call("vaultList");
    await expect(client.shutdown()).rejects.toThrow("内核线程意外退出");
  });

  it("keeps the parent responsive while work is blocked and drains requests before shutdown", async () => {
    const { client, gate } = start();
    let completed = false;
    const read = client.call("fileRead", "a.md").then((bytes) => {
      completed = true;
      return bytes;
    });
    const list = client.call("vaultList");
    await vi.waitFor(() => expect(Atomics.load(gate, 0)).toBe(1));

    const stopping = client.shutdown();
    expect(client.shutdown()).toBe(stopping);
    await expect(client.call("vaultList")).rejects.toThrow("内核正在关闭");
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(completed).toBe(false);
        Atomics.store(gate, 1, 1);
        Atomics.notify(gate, 1);
        resolve();
      }, 20);
    });
    expect(await read).toEqual(new Uint8Array([42]));
    expect(await list).toEqual(["1"]);
    await stopping;
  });

  it("preserves per-command errors without poisoning the following request", async () => {
    const { client } = start();
    const rename = expect(client.call("entryRename", "a.md", "b.md")).rejects.toThrow(
      "目标已存在：b.md",
    );
    const first = client.call("vaultList");
    const second = client.call("vaultList");
    await rename;
    expect(await first).toEqual(["1"]);
    expect(await second).toEqual(["2"]);
    await client.shutdown();
  });

  it.each(["crash", "exit"])(
    "rejects every pending and future call after unexpected %s",
    async (mode) => {
      const { client } = start(mode);
      await Promise.all([
        expect(client.call("vaultList")).rejects.toThrow(),
        expect(client.call("fileRead", "a.md")).rejects.toThrow(),
        expect(client.shutdown()).rejects.toThrow(),
      ]);
      await expect(client.call("vaultList")).rejects.toThrow();
    },
  );
});
