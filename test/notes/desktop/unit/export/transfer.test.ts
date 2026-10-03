import { once } from "node:events";
import { MessageChannel, markAsUntransferable } from "node:worker_threads";
import { isUint8Array } from "node:util/types";
import { describe, expect, it } from "vitest";
import { exportByteTransfer } from "@reader/main/export/transfer";

describe("EXP-TRANSFER 真实线程消息的字节所有权", () => {
  it("独占缓冲区不复制，实际发送后脱离发送方并保留全部内容", async () => {
    const source = new Uint8Array([1, 2, 3]);
    const packet = exportByteTransfer(source);
    expect(packet.bytes).toBe(source);
    const { port1, port2 } = new MessageChannel();
    try {
      const received = once(port2, "message");
      port1.postMessage(packet.bytes, packet.transfer);
      expect(source.byteLength).toBe(0);
      const [value]: unknown[] = await received;
      if (!isUint8Array(value)) throw new Error("线程未收到字节消息");
      expect([...value]).toEqual([1, 2, 3]);
    } finally {
      port1.close();
      port2.close();
    }
  });

  it.for(["pool", "offset", "short", "marked", "shared"])(
    "%s 输入仅传有效字节，发送不会分离原文或相邻数据",
    async (kind) => {
      const backing = new Uint8Array([9, 1, 2, 3, 8]);
      let source: Uint8Array;
      switch (kind) {
        case "pool":
          source = Buffer.from([1, 2, 3]);
          break;
        case "offset":
          source = backing.subarray(1, 4);
          break;
        case "short":
          source = new Uint8Array([1, 2, 3, 8]).subarray(0, 3);
          break;
        case "marked":
          source = new Uint8Array([1, 2, 3]);
          markAsUntransferable(source.buffer);
          break;
        default:
          source = new Uint8Array(new SharedArrayBuffer(3));
          source.set([1, 2, 3]);
      }
      const packet = exportByteTransfer(source);
      expect(packet.bytes).not.toBe(source);
      expect(packet.bytes.buffer.byteLength).toBe(3);
      const { port1, port2 } = new MessageChannel();
      try {
        const received = once(port2, "message");
        port1.postMessage(packet.bytes, packet.transfer);
        const [value]: unknown[] = await received;
        if (!isUint8Array(value)) throw new Error("线程未收到字节消息");
        expect([...value]).toEqual([1, 2, 3]);
        expect([...source]).toEqual([1, 2, 3]);
        expect([...backing]).toEqual([9, 1, 2, 3, 8]);
      } finally {
        port1.close();
        port2.close();
      }
    },
  );
});
