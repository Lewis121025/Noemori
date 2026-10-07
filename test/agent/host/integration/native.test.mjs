import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const { NativeAgentSession } = require("../../../../modules/agent/node/index.js");

async function wait(session, predicate) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = JSON.parse(session.snapshot());
    if (predicate(value)) return value;
    await new Promise((done) => setTimeout(done, 5));
  }
  throw new Error("原生会话未交付预期状态");
}

test("native Agent round trip requires current approval and closes real terminals", async () => {
  const root = await mkdtemp(join(tmpdir(), "noemori-agent-native-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const secret = join(root, "secret");
  await writeFile(secret, "approved-content");
  let request = 0;
  const server = createServer(async (input, output) => {
    const pieces = [];
    for await (const piece of input) pieces.push(piece);
    const body = JSON.parse(Buffer.concat(pieces).toString());
    assert.ok(body.tools.some((tool) => tool.function.name === "terminal"));
    request += 1;
    const message = request === 1 ? {
      role: "assistant", content: null, tool_calls: [{ id: "approval", type: "function", function: {
        name: "terminal", arguments: JSON.stringify({ action: "exec", cmd: "printf bridge; sleep 30", yield_time_ms: 0,
          permission_request: { reason: "读取选择的外部文件", readable_paths: [secret] } }),
      } }],
    } : { role: "assistant", content: "完成" };
    output.writeHead(200, { "content-type": "application/json" });
    output.end(JSON.stringify({ id: `fixture-${request}`, choices: [{ index: 0, message, finish_reason: request === 1 ? "tool_calls" : "stop" }] }));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  let session;
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    let changes = 0;
    session = new NativeAgentSession(JSON.stringify({
      workspace, shell: "/bin/sh", launcher: resolve("modules/agent/target/debug/noemori-terminal-sandbox"), permission_store: null,
      model: { protocol: "openai-chat", model: "fixture", endpoint: `http://127.0.0.1:${address.port}/chat`, authentication: { type: "none" }, tools: true, streaming: false },
    }), () => { changes += 1; });
    session.start("读取工作区");
    const pending = await wait(session, (value) => value.approvals.length === 1);
    const approval = pending.approvals[0];
    assert.equal(approval.request.type, "terminal");
    assert.equal(approval.request.request.permissions.readable_paths[0], await realpath(secret));
    session.approve(approval.id, JSON.stringify({ type: "terminal", decision: { decision: "allow_once" } }));
    const completed = await wait(session, (value) => value.run?.status === "completed" && value.terminals.length === 1 && value.terminals[0].bytes >= 6);
    assert.ok(changes > 0);
    assert.equal(completed.approvals.length, 0);
    assert.equal(completed.messages.at(-1).content[0].value, "完成");
    const page = JSON.parse(await session.readTerminal(completed.terminals[0].process.session_id, "0", 8192));
    assert.equal(Buffer.concat(page.chunks.map((chunk) => Buffer.from(chunk.data_base64, "base64"))).toString(), "bridge");
    assert.throws(() => session.approve(approval.id, JSON.stringify({ type: "terminal", decision: { decision: "allow_once" } })), /审批/);
    await session.close();
    const closed = JSON.parse(session.snapshot());
    assert.equal(closed.closed, true);
    assert.ok(closed.terminals.every((terminal) => terminal.process.status !== "running"));
    assert.throws(() => session.start("迟到运行"), /关闭/);
    assert.equal(await readFile(secret, "utf8"), "approved-content");
  } finally {
    if (session) await session.close();
    await new Promise((done) => server.close(done));
    await rm(root, { recursive: true, force: true });
  }
});
