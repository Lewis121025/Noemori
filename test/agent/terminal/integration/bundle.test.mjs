import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repository = fileURLToPath(new URL("../../../../", import.meta.url));
const script = join(repository, "modules/agent/scripts/prepare-ripgrep.mjs");
const host = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/^host: (.+)$/m)[1];

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "noemori bundle "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("准备资源拒绝损坏的上游归档，不回退到系统 rg", async (t) => {
  const directory = await fixture(t);
  const copied = join(directory, "scripts/prepare-ripgrep.mjs");
  await mkdir(dirname(copied));
  await cp(script, copied);
  const cache = join(directory, ".cache/ripgrep", host);
  await mkdir(cache, { recursive: true });
  const original = join(repository, "modules/agent/.cache/ripgrep", host);
  const archive = (await readdir(original)).find((name) => name.endsWith(".tar.gz"));
  assert.ok(archive);
  await writeFile(join(cache, archive), "corrupt archive");
  const failed = spawnSync(process.execPath, [copied, host], { encoding: "utf8", timeout: 15_000 });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /构建资源摘要不符/);
  assert.deepEqual(await readdir(cache), [archive]);

  await cp(join(original, archive), join(cache, archive));
  execFileSync(process.execPath, [copied, host], { timeout: 30_000 });
  assert.match(
    execFileSync(join(cache, "rg"), ["--version"], { encoding: "utf8" }),
    /^ripgrep 15\.2\.0/,
  );
  assert.match(await readFile(join(cache, "LICENSE-ripgrep"), "utf8"), /Copyright/);
  assert.ok(!(await readdir(cache)).some((name) => name.startsWith("prepare-")));
});

test("不支持的平台在下载前明确失败", async (t) => {
  const directory = await fixture(t);
  const failed = spawnSync(process.execPath, [script, "unsupported-target"], {
    cwd: directory,
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /尚不支持目标平台/);
  assert.deepEqual(await readdir(directory), []);
});

test("发布目录搬迁后无需构建缓存、系统 rg 或网络即可搜索", async (t) => {
  const directory = await fixture(t);
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
      {
        cwd: repository,
        encoding: "utf8",
      },
    ),
  );
  const output = join(
    metadata.target_directory,
    ...(process.env.CARGO_BUILD_TARGET ? [process.env.CARGO_BUILD_TARGET] : []),
    "debug",
  );
  await cp(join(output, "examples/terminal"), join(directory, "terminal"));
  await cp(join(output, "noemori-terminal-sandbox"), join(directory, "noemori-terminal-sandbox"));
  const workspace = join(directory, "notes with spaces");
  await mkdir(workspace);
  await writeFile(join(workspace, "note.txt"), "bundled needle\n");
  const result = execFileSync(
    join(directory, "terminal"),
    ["rg --color never -n needle note.txt"],
    {
      cwd: workspace,
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", SHELL: "/bin/sh" },
      encoding: "utf8",
      timeout: 15_000,
    },
  );
  assert.equal(result, "1:bundled needle\n");
});
