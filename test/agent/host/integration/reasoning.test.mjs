import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";

const require = createRequire(import.meta.url);
const { NativeAgentSession } = require("../../../../modules/agent/node/index.js");

for (const protocol of ["openai-chat", "openai-responses"]) {
  test(`${protocol} 的原生会话将每轮推理选择传入请求，默认值不继承上一轮`, { timeout: 15000 }, async () => {
    const workspace = await mkdtemp(join(tmpdir(), "noemori-native-reasoning-"));
    const requests = [];
    const server = createServer(async (input, output) => {
      const pieces = [];
      for await (const piece of input) pieces.push(piece);
      requests.push(JSON.parse(Buffer.concat(pieces).toString()));
      const response = protocol === "openai-chat"
        ? { choices: [{ index: 0, message: { role: "assistant", content: "完成" }, finish_reason: "stop" }] }
        : { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "完成" }] }] };
      output.writeHead(200, { "content-type": "application/json" });
      output.end(JSON.stringify(response));
    });
    let session;
    try {
      await new Promise((done) => server.listen(0, "127.0.0.1", done));
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const model = {
        protocol, model: "fixture", endpoint: `http://127.0.0.1:${address.port}/model`,
        authentication: { type: "none" }, tools: true, streaming: false,
      };
      session = new NativeAgentSession(JSON.stringify({
        workspace, shell: "/bin/sh", launcher: resolve("modules/agent/target/debug/noemori-terminal-sandbox"),
        permission_store: null, model,
      }), () => {});
      for (const effort of ["high", "none", "minimal", "ULTRA", undefined]) {
        const run = session.startConfigured(
          JSON.stringify({ ...model, ...(effort === undefined ? {} : { reasoningEffort: effort }) }),
          "reasoning-fixture", "继续",
        );
        const deadline = Date.now() + 5000;
        let snapshot;
        do {
          await setTimeout(5);
          snapshot = JSON.parse(session.snapshot());
        } while (snapshot.run?.status === "running" && Date.now() < deadline);
        assert.equal(snapshot.run?.id, run);
        assert.equal(snapshot.run?.status, "completed", snapshot.run?.error);
        const body = requests.at(-1);
        assert.ok(body);
        if (protocol === "openai-chat") {
          assert.equal(body.reasoning_effort, effort);
          assert.equal(Object.hasOwn(body, "reasoning"), false);
        } else {
          assert.equal(body.reasoning?.effort, effort);
          assert.equal(Object.hasOwn(body, "reasoning_effort"), false);
          if (effort === undefined) assert.equal(Object.hasOwn(body, "reasoning"), false);
        }
      }
      assert.equal(requests.length, 5);
    } finally {
      if (session) await session.close();
      await new Promise((done) => server.close(done));
      await rm(workspace, { recursive: true, force: true });
    }
  });
}
