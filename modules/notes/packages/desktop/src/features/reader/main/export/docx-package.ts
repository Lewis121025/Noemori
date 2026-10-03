import { createHash } from "node:crypto";
import { posix } from "node:path";
import { Uint8ArrayReader, ZipReader } from "@zip.js/zip.js";
import { EXPORT_LIMITS } from "../../shared/export";
import { errorText } from "./errors";

/** 独立 ZIP 校验结果只保留 XML；媒体逐项计算摘要后释放，不占整包解压大小的内存。 */
export type DocxPackage = {
  entries: Record<string, Uint8Array>;
  names: ReadonlySet<string>;
  media: ReadonlySet<string>;
};

/**
 * 按条目流式校验 CRC、实际长度、重叠和路径，再交给 OOXML 语义校验。
 * @throws 包损坏、加密、越界或 XML 超过任务内存预算时拒绝；取消中断当前解压。
 */
export async function readDocxPackage(
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<DocxPackage> {
  const archive = new ZipReader(new Uint8ArrayReader(bytes), {
    checkSignature: true,
    checkOverlappingEntry: true,
    useWebWorkers: false,
  });
  const entries: Record<string, Uint8Array> = Object.create(null);
  const names = new Set<string>();
  const media = new Set<string>();
  let xmlBytes = 0;
  try {
    for await (const entry of archive.getEntriesGenerator()) {
      signal?.throwIfAborted();
      const name = entry.filename;
      if (
        !name ||
        names.has(name) ||
        name.includes("\\") ||
        name.includes("\0") ||
        name.startsWith("/") ||
        posix.normalize(name) !== name ||
        name.startsWith("../") ||
        entry.encrypted
      )
        throw new Error("DOCX 包含重复、加密或无效部件路径");
      names.add(name);
      if (entry.directory) continue;
      const xml = name.endsWith(".xml") || name.endsWith(".rels");
      if (xml) {
        xmlBytes += entry.uncompressedSize;
        if (xmlBytes > EXPORT_LIMITS.memoryBytes) throw new Error("DOCX XML 超过任务内存预算");
      }
      const chunks: Uint8Array[] = [];
      const digest = createHash("sha256");
      let length = 0;
      await entry.getData(
        new WritableStream<Uint8Array>({
          write(chunk) {
            signal?.throwIfAborted();
            length += chunk.byteLength;
            if (length > entry.uncompressedSize) throw new Error("DOCX 部件长度与清单不符");
            digest.update(chunk);
            if (xml) chunks.push(chunk);
          },
        }),
        signal ? { signal } : {},
      );
      if (length !== entry.uncompressedSize) throw new Error("DOCX 部件长度与清单不符");
      if (xml) entries[name] = Buffer.concat(chunks, length);
      if (name.startsWith("word/media/")) media.add(digest.digest("hex"));
    }
    return { entries, names, media };
  } catch (error) {
    throw new Error(`DOCX 包校验失败：${errorText(error)}`, { cause: error });
  } finally {
    await archive.close();
  }
}
