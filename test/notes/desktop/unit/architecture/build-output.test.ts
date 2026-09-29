import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../../../", import.meta.url));

it("同一 Rust 工作区从仓库根、模块和原生包启动时使用唯一构建目录", () => {
  const env = { ...process.env };
  // 用户可显式指定外部缓存；此检查验证没有覆盖参数时的项目默认行为。
  delete env.CARGO_TARGET_DIR;
  delete env.CARGO_BUILD_TARGET_DIR;
  const cases = [
    {
      workspace: "modules/notes",
      directories: [".", "modules/notes", "modules/notes/packages/vault-node"],
    },
    { workspace: "modules/agent", directories: [".", "modules/agent"] },
  ];
  for (const item of cases) {
    for (const directory of item.directories) {
      const output = execFileSync(
        "cargo",
        [
          "metadata",
          "--manifest-path",
          join(root, item.workspace, "Cargo.toml"),
          "--no-deps",
          "--format-version",
          "1",
          "--locked",
        ],
        { cwd: join(root, directory), env, encoding: "utf8" },
      );
      const metadata: unknown = JSON.parse(output);
      if (typeof metadata !== "object" || metadata === null || !("target_directory" in metadata))
        throw new Error("Cargo 未返回构建目录");
      expect(metadata.target_directory, directory).toBe(join(root, item.workspace, "target"));
    }
  }
});
