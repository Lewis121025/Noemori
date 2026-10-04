import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

// 固定候选随源码分发，让干净检出也使用同一已验证权重。
const source = new URL("../../../../whiteboard/ink/models/model.onnx", import.meta.url);
const target = new URL("../.cache/ink/", import.meta.url);
const bytes = await readFile(source);
if (
  createHash("sha256").update(bytes).digest("hex") !==
  "a60b874423a03f24f727bf2bd8c38010f2ea4dbc5e66e57c7d085f4109c8cf8c"
)
  throw new Error("图形识别权重与已验证候选不一致");
await mkdir(target, { recursive: true });
await writeFile(new URL("model.onnx", target), bytes);
