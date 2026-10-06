import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

// 固定候选随源码分发，让干净检出也使用同一已验证权重。
const source = new URL("../../../../whiteboard/ink/models/model.onnx", import.meta.url);
const target = new URL("../.cache/ink/", import.meta.url);
const bytes = await readFile(source);
if (
  createHash("sha256").update(bytes).digest("hex") !==
  "b79aa43a3b66ae45280023c4fe3f85abef6b624111d4c2bf54aa40b527a69094"
)
  throw new Error("图形识别权重与已验证候选不一致");
await mkdir(target, { recursive: true });
await writeFile(new URL("model.onnx", target), bytes);
