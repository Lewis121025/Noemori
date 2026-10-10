import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";

const { NativeAgentSession } = createRequire(import.meta.url)("../../../../modules/agent/node/index.js");

for (const protocol of ["openai-chat", "openai-responses"]) {
  test(`${protocol} 从重启后的中断节点重发相同请求，不新增用户消息`, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "noemori-native-resume-"));
    const requests = [];
    const server = createServer(async (input, output) => {
      const pieces = [];
      for await (const piece of input) pieces.push(piece);
      requests.push(JSON.parse(Buffer.concat(pieces).toString()));
      output.writeHead(requests.length === 1 ? 400 : 200, { "content-type": "application/json" });
      output.end(JSON.stringify(requests.length === 1 ? { error: "请求被中断" } : protocol === "openai-chat"
        ? { choices: [{ index: 0, message: { role: "assistant", content: "完成" }, finish_reason: "stop" }] }
        : { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "完成" }] }] }));
    });
    let session;
    try {
      await new Promise((done) => server.listen(0, "127.0.0.1", done));
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const model = { protocol, model: "fixture", endpoint: `http://127.0.0.1:${address.port}/model`, authentication: { type: "none" }, tools: false, streaming: false };
      const configuration = JSON.stringify({ workspace, shell: "/bin/sh", launcher: resolve("modules/agent/target/debug/noemori-terminal-sandbox"), permission_store: null, model });
      session = new NativeAgentSession(configuration, () => {});
      const run = session.startConfigured(JSON.stringify(model), "resume-fixture", "原任务", "原始上下文");
      const settled = async () => {
        for (let count = 0; count < 1000; count += 1) {
          const snapshot = JSON.parse(session.snapshot());
          if (snapshot.run?.status !== "running") return snapshot;
          await setTimeout(5);
        }
        throw new Error("原生运行未结算");
      };
      assert.equal((await settled()).run.status, "failed");
      const saved = JSON.parse(session.checkpoint());
      if (protocol === "openai-chat") {
        saved.version = 1;
        delete saved.turns;
        delete saved.pending_turn;
      }
      const checkpoint = JSON.stringify(saved);
      await session.close();
      session = new NativeAgentSession(configuration, () => {});
      session.restore(checkpoint);
      const resumed = session.resumeConfigured(run, JSON.stringify(model), "resume-fixture");
      assert.notEqual(resumed, run);
      assert.throws(() => session.resumeConfigured(run, JSON.stringify(model), "resume-fixture"));
      const snapshot = await settled();
      assert.equal(snapshot.run.status, "completed", snapshot.run.error);
      assert.equal(snapshot.messages.filter((message) => message.role === "user").length, 1);
      assert.equal(snapshot.turns[1].resumed_from, run);
      assert.equal(requests.length, 2);
      assert.deepEqual(requests[1], requests[0]);
      assert.ok(!JSON.stringify(requests[1]).includes("上次运行尚未完成"));
    } finally {
      if (session) await session.close();
      await new Promise((done) => server.close(done));
      await rm(workspace, { recursive: true, force: true });
    }
  });
}
