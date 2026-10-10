import test from "node:test";
import assert from "node:assert/strict";
import { outputPeer } from "../support/output-peer.mjs";

test("网页辅助程序的失败输出遇到断管时明确诊断并终结控制会话", { timeout: 10000 }, async (t) => {
  const peer = outputPeer(
    t,
    new URL("../../../../modules/agent/web-runtime/dist/main.js", import.meta.url),
  );
  peer.disconnect();
  await peer.send({});
  assert.equal((await peer.exited)[0], 1, peer.stderr());
  assert.match(peer.stderr(), /控制输出失败.*EPIPE/s);
  assert.doesNotMatch(
    peer.stderr(),
    /Unhandled 'error' event|node:events:|node:internal\/process\/promises/,
  );
});

test("网页辅助程序仍读取EOF前的完整控制帧并交付失败结果", { timeout: 10000 }, async (t) => {
  const peer = outputPeer(
    t,
    new URL("../../../../modules/agent/web-runtime/dist/main.js", import.meta.url),
  );
  peer.child.stdin.end("{}\n");
  const frames = [];
  for await (const line of peer.frames) frames.push(JSON.parse(line));
  assert.equal((await peer.exited)[0], 1, peer.stderr());
  assert.deepEqual(
    frames.map((frame) => frame.kind),
    ["failed"],
  );
  assert.doesNotMatch(peer.stderr(), /控制输出失败|Unhandled|EPIPE/);
});
