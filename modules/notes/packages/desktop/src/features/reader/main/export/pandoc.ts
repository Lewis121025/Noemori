import { isUint8Array } from "node:util/types";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import type { PreparedExportDocument } from "./documents";
import { EXPORT_LIMITS } from "../../shared/export";
import { packExportDocument, parsePreparedDocx, type ExportComputation } from "./computation";
import type { ExportImageSize } from "./pandoc-document";

/**
 * 使用固定随包引擎生成 DOCX；警告即失败，不回退到系统命令或图片公式。
 * @param executable 构建产物内的绝对可执行文件路径。
 * @throws 取消、超时、子进程故障、警告、产物超限或结构不符时拒绝。
 */
export async function exportDocx(
  document: PreparedExportDocument,
  directory: string,
  signal: AbortSignal,
  compute: ExportComputation,
  executable = join(__dirname, "pandoc/pandoc"),
  imageSizes: ReadonlyMap<string, ExportImageSize> = new Map(),
): Promise<Uint8Array> {
  signal.throwIfAborted();
  const images = new Map<string, ExportImageSize>();
  document.doc.descendants((node) => {
    if (node.type.name !== "image") return;
    const source = String(node.attrs["src"]);
    const size = imageSizes.get(source);
    if (!size) throw new Error("DOCX 图片缺少已验证的显示尺寸");
    images.set(source, size);
  });
  const prepared = parsePreparedDocx(
    await compute({
      kind: "prepareDocx",
      document: packExportDocument(document),
      directory,
      images: [...images].map(([path, { width, height }]) => ({ path, width, height })),
    }),
  );
  const result = await runPandoc(executable, prepared.input, directory, signal);
  const validated = await compute({
    kind: "validateDocx",
    bytes: result,
    expected: prepared.expected,
    media: prepared.media,
  });
  if (!isUint8Array(validated)) throw new Error("DOCX 校验响应无效");
  return validated;
}

function runPandoc(
  executable: string,
  input: string,
  directory: string,
  signal: AbortSignal,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const child = spawn(
      executable,
      [
        "--from=json",
        "--to=docx",
        "--standalone",
        "--dpi=96",
        "--fail-if-warnings",
        "--syntax-highlighting=none",
        `--reference-doc=${join(dirname(executable), "reference.docx")}`,
        `--resource-path=${directory}`,
        `--data-dir=${directory}`,
      ],
      {
        cwd: directory,
        env: { LANG: "en_US.UTF-8", PATH: "/usr/bin:/bin" },
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      },
    );
    const chunks: Buffer[] = [];
    let length = 0;
    let diagnostic = "";
    let failure: Error | null = null;
    const stop = (error: Error) => {
      failure ??= error;
      child.kill("SIGKILL");
    };
    const abort = () => stop(new Error("导出已取消"));
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => stop(new Error("DOCX 转换超过 180 秒")), EXPORT_LIMITS.renderMs);
    child.stdout.on("data", (chunk: Buffer) => {
      length += chunk.byteLength;
      if (length * 2 > EXPORT_LIMITS.memoryBytes)
        stop(new Error("DOCX 产物缓存将超过 2 GiB 内存预算"));
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      diagnostic = (diagnostic + chunk.toString("utf8")).slice(0, 32_768);
    });
    child.on("error", (error) => {
      failure ??= error;
    });
    child.stdin.on("error", (error) => {
      failure ??= error;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code !== 0 || diagnostic.trim() !== "")
        reject(new Error(`DOCX 转换失败：${diagnostic.trim() || `退出码 ${code}`}`));
      else resolve(Buffer.concat(chunks, length));
    });
    child.stdin.end(input);
  });
}
