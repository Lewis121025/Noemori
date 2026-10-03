import { copyFile, mkdir, readdir, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

// Pandoc 与 NAPI 是本次测试的外部边界，复用构建依赖；不链接被变异的源码目录。
const source = process.env.NOEMORI_MUTATION_SOURCE;
if (!source || resolve(source) === process.cwd()) throw new Error("变异测试必须在独立沙箱执行");
const relative = "modules/notes/packages/desktop/.cache/pandoc-3.12";
const destination = join(process.cwd(), relative);
await mkdir(dirname(destination), { recursive: true });
await symlink(join(source, relative), destination, "dir");

// 原生边界也固定为本次构建，避免其他任务重建 NAPI 时改变正在执行的变异基线。
const native = "modules/notes/packages/vault-node";
const binaries = (await readdir(join(source, native))).filter((name) => name.endsWith(".node"));
if (!binaries.length) throw new Error("变异测试缺少已构建的原生内核");
for (const name of binaries)
  await copyFile(join(source, native, name), join(process.cwd(), native, name));
