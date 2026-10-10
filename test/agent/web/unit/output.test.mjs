import test from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { ControlOutput } from "../../../../modules/agent/web-runtime/dist/output.js";

test("控制输出的stream错误先于写入回调时，进行中的帧不能被报告为成功", async () => {
  let complete;
  const stream = new Writable({
    write(_bytes, _encoding, callback) {
      complete = callback;
    },
  });
  const output = new ControlOutput(stream);
  const delivered = output.write({ kind: "ready" });
  const original = new Error("write EPIPE");
  stream.emit("error", original);
  complete();
  await assert.rejects(delivered, (error) => error.cause === original);
  assert.equal(output.signal.aborted, true);
  await assert.rejects(output.write({ kind: "failed" }), (error) => error === output.error);
});

test("控制输出的回调与stream同时失败时，保留首个原始错误并只中止一次", async () => {
  const original = new Error("write EPIPE");
  const stream = new Writable({
    write(_bytes, _encoding, callback) {
      callback(original);
    },
  });
  const output = new ControlOutput(stream);
  let aborted = 0;
  output.signal.addEventListener("abort", () => {
    aborted++;
  });
  await assert.rejects(output.write({ kind: "ready" }), (error) => error.cause === original);
  stream.emit("error", new Error("迟到的输出错误"));
  assert.equal(output.error.cause, original);
  assert.equal(aborted, 1);
});
