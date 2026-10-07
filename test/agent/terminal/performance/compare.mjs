import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

// 两端均复用进程、经 JSON/stdin/stdout 通信，使用同一目录、shell 与完整权限。
// 不启动模型请求；性能数据与功能断言分开，不用机器负载波动决定测试是否通过。
const repository = fileURLToPath(new URL("../../../../", import.meta.url));
const metadata = JSON.parse(
  execFileSync(
    "cargo",
    [
      "metadata",
      "--manifest-path",
      "modules/agent/Cargo.toml",
      "--no-deps",
      "--format-version",
      "1",
      "--locked",
    ],
    { cwd: repository, encoding: "utf8" },
  ),
);
const executable = join(metadata.target_directory, "release/examples/terminal-probe");
const directory = await mkdtemp(join(tmpdir(), "noemori comparison "));

class Connection {
  pending = new Map();
  sequence = 0;
  constructor(command, args) {
    this.child = spawn(command, args, { cwd: directory, stdio: ["pipe", "pipe", "ignore"] });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => {
      const response = JSON.parse(line);
      const request = this.pending.get(response.id);
      if (request) {
        clearTimeout(request.timer);
        this.pending.delete(response.id);
        request.resolve(response);
      }
    });
    this.exited = new Promise((resolve) => {
      this.child.once("exit", (code, signal) => {
        for (const request of this.pending.values()) {
          clearTimeout(request.timer);
          request.reject(new Error(`执行服务提前退出：${code ?? signal}`));
        }
        this.pending.clear();
        resolve();
      });
      this.child.once("error", (error) => {
        for (const request of this.pending.values()) {
          clearTimeout(request.timer);
          request.reject(error);
        }
        this.pending.clear();
        resolve();
      });
    });
  }
  notify(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  request(message) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("执行服务响应超过 30 秒"));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.notify({ id, ...message });
    });
  }
  async close() {
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 3000);
    await this.exited;
    clearTimeout(timer);
    this.lines.close();
  }
}

const noemori = new Connection(executable, []);
const codex = new Connection("codex", ["app-server", "--listen", "stdio://"]);
const checked = (response) => {
  assert.equal(response.error, undefined, JSON.stringify(response.error));
  return response.result;
};
const noemoriExec = async (command, cap = 30_000) =>
  checked(
    await noemori.request({
      arguments: { action: "exec", cmd: command, yield_time_ms: 30_000, max_output_chars: cap },
    }),
  );
const codexExec = async (command, extra = {}) =>
  checked(
    await codex.request({
      method: "command/exec",
      params: {
        command: ["/bin/sh", "-c", command],
        cwd: directory,
        sandboxPolicy: { type: "dangerFullAccess" },
        timeoutMs: 30_000,
        ...extra,
      },
    }),
  );
const median = (samples) => [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)];

try {
  checked(
    await codex.request({
      method: "initialize",
      params: { clientInfo: { name: "noemori_terminal_benchmark", version: "0.1.0" } },
    }),
  );
  codex.notify({ method: "initialized", params: {} });
  for (let index = 0; index < 8; index++) {
    assert.equal((await noemoriExec("printf warmup")).output, "warmup");
    assert.equal((await codexExec("printf warmup")).stdout, "warmup");
  }
  const timings = { noemori: [], codex: [] };
  for (let index = 0; index < 40; index++) {
    for (const name of index % 2 === 0 ? ["noemori", "codex"] : ["codex", "noemori"]) {
      const start = performance.now();
      const result = await (name === "noemori"
        ? noemoriExec("printf probe")
        : codexExec("printf probe"));
      assert.equal(name === "noemori" ? result.output : result.stdout, "probe");
      timings[name].push(performance.now() - start);
    }
  }
  const parallel = {};
  for (const [name, execute] of [
    ["noemori", noemoriExec],
    ["codex", codexExec],
  ]) {
    const samples = [];
    for (let sample = 0; sample < 3; sample++) {
      const start = performance.now();
      const results = await Promise.all(
        Array.from({ length: 4 }, () => execute("sleep 0.15; printf done")),
      );
      for (const result of results)
        assert.equal(name === "noemori" ? result.output : result.stdout, "done");
      samples.push(performance.now() - start);
    }
    parallel[name] = median(samples);
  }
  const command = "head -c 100000 /dev/zero | tr '\\000' x";
  const preview = await noemoriExec(command, 256);
  const capped = await codexExec(command, { outputBytesCap: 256, processId: "bounded-output" });
  assert.equal(preview.truncated, true);
  let offset = 0;
  do {
    const page = checked(
      await noemori.request({
        arguments: {
          action: "read",
          session_id: preview.session_id,
          offset,
          max_output_chars: 4096,
        },
      }),
    );
    assert.match(page.output, /^x*$/);
    offset = page.next_offset;
    if (!page.has_more) break;
  } while (offset < 100000);
  assert.equal(offset, 100000);
  const afterExit = await codex.request({
    method: "command/exec/write",
    params: { processId: "bounded-output", deltaBase64: "" },
  });
  console.log(
    JSON.stringify(
      {
        codex_version: execFileSync("codex", ["--version"], { encoding: "utf8" }).trim(),
        platform: process.platform,
        architecture: process.arch,
        samples: 40,
        small_command_median_ms: { noemori: median(timings.noemori), codex: median(timings.codex) },
        four_parallel_commands_median_ms: parallel,
        bounded_output: {
          noemori_preview_chars: preview.output.length,
          noemori_replayed_bytes: offset,
          codex_captured_bytes: Buffer.byteLength(capped.stdout),
          codex_completed_session_write_error: afterExit.error ?? null,
        },
        caveat:
          "仅比较本机当前版本的 stdio 执行接口；两端均关闭沙箱，Noemori 默认保存可回读日志。Codex 可另行选择无截断或流式输出。",
      },
      null,
      2,
    ),
  );
} finally {
  await Promise.allSettled([noemori.close(), codex.close()]);
  await rm(directory, { recursive: true, force: true });
}
