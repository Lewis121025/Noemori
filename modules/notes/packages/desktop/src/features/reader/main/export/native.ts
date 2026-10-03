import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import type { NativeControl } from "@noemori/vault-node";
import type { ExportRequest } from "../../shared/export";
import { EXPORT_LIMITS } from "../../shared/export";
import { isEntryPath } from "../../shared/file-browser";
import { parseLinkTarget } from "../../shared/reader-protocol";
import { errorText } from "./errors";
import type { LinkKind, LinkTarget } from "../../shared/api";

/** 仅可信宿主可以调用的原生动作；页面只获得最终导出接口。 */
export type ExportNativeAction =
  | { action: "info" | "seal" | "discard" | "outcome" | "preserve" | "acknowledge" }
  | { action: "include" | "directory" | "target"; path: string }
  | { action: "resolve"; from: string; raw: string; kind: LinkKind }
  | { action: "copy"; source: string; path: string }
  | { action: "write"; path: string; resource: boolean }
  | { action: "publish"; single: string | null };
/** 产物裁剪只移除已嵌入文档的中间图片，不处理原始源文件。 */
export type ExportRetainAction = { action: "retain"; paths: string[] };

/** 原生层与任务协调器的有限适配接口，测试可以替换边界。 */
export type ExportNativePort = {
  prepare: (
    root: string,
    id: string,
    paths: string[] | null,
    hidden: boolean,
    control: NativeControl,
  ) => Promise<unknown>;
  action: (
    id: string,
    action: ExportNativeAction | ExportRetainAction,
    bytes?: Uint8Array,
  ) => Promise<unknown>;
};
/** 原生快照清单中的一个文件。 */
export type ExportSource = { path: string; bytes: number; hash: string };
/** 暂存路径只存在于宿主中，禁止将该结构转发给页面。 */
export type ExportSnapshot = {
  id: string;
  sourceDirectory: string;
  outputDirectory: string;
  files: ExportSource[];
  directories: string[];
  bytes: number;
  resourceBytes: number;
  resources: number;
  sealed: boolean;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 严格校验原生清单，未知响应不能被当作空导出。 */
export function parseExportSnapshot(value: unknown): ExportSnapshot {
  if (
    !record(value) ||
    typeof value.id !== "string" ||
    !/^[a-zA-Z0-9-]{1,100}$/.test(value.id) ||
    typeof value.sourceDirectory !== "string" ||
    !isAbsolute(value.sourceDirectory) ||
    typeof value.outputDirectory !== "string" ||
    !isAbsolute(value.outputDirectory) ||
    !Array.isArray(value.files) ||
    !Array.isArray(value.directories) ||
    !value.directories.every(isEntryPath) ||
    typeof value.bytes !== "number" ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 0 ||
    typeof value.resourceBytes !== "number" ||
    !Number.isSafeInteger(value.resourceBytes) ||
    value.resourceBytes < 0 ||
    typeof value.resources !== "number" ||
    !Number.isSafeInteger(value.resources) ||
    value.resources < 0 ||
    typeof value.sealed !== "boolean"
  )
    throw new Error("原生导出快照无效");
  const files = value.files.map((file: unknown): ExportSource => {
    if (
      !record(file) ||
      !isEntryPath(file.path) ||
      typeof file.bytes !== "number" ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      typeof file.hash !== "string" ||
      !/^[a-f0-9]{64}$/.test(file.hash)
    )
      throw new Error("导出文件清单无效");
    return { path: file.path, bytes: file.bytes, hash: file.hash };
  });
  if (
    new Set(files.map((file) => file.path)).size !== files.length ||
    files.length + value.resources > EXPORT_LIMITS.files ||
    files.reduce((sum, file) => sum + file.bytes, 0) !== value.bytes ||
    value.bytes + value.resourceBytes > EXPORT_LIMITS.bytes
  )
    throw new Error("导出清单数量或字节统计无效");
  return {
    id: value.id,
    sourceDirectory: value.sourceDirectory,
    outputDirectory: value.outputDirectory,
    files,
    directories: value.directories,
    bytes: value.bytes,
    resourceBytes: value.resourceBytes,
    resources: value.resources,
    sealed: value.sealed,
  };
}

/** 一项原生导出能力；源路径必须已被任务收集，任何读写失败均向上传播。 */
export class NativeExport {
  private preserveEvidence = false;
  private readonly outputs = new Map<string, { bytes: number; hash: string }>();
  private constructor(
    private readonly port: ExportNativePort,
    public snapshot: ExportSnapshot,
    private readonly control: NativeControl,
  ) {}

  /** 创建并校验任务；目录选择与全栏保存由调用方先完成。 */
  static async prepare(
    port: ExportNativePort,
    request: ExportRequest,
    id: string,
    control: NativeControl,
  ): Promise<NativeExport> {
    const value = await port.prepare(
      request.root,
      id,
      request.scope.kind === "vault" ? null : request.scope.paths,
      request.format === "archive",
      control,
    );
    const snapshot = parseExportSnapshot(value);
    if (snapshot.id !== id) throw new Error("导出快照任务身份不一致");
    return new NativeExport(port, snapshot, control);
  }

  /** 收集单一依赖并更新已冻结清单；封存后由原生层拒绝。 */
  async include(path: string): Promise<void> {
    if (this.snapshot.files.some((file) => file.path === path)) return;
    this.snapshot = parseExportSnapshot(
      await this.port.action(this.snapshot.id, { action: "include", path }),
    );
  }
  /** 使用任务捕获的链接身份解析，保持同名歧义而不自行猜测。 */
  async resolve(from: string, raw: string, kind: LinkKind): Promise<LinkTarget> {
    return parseLinkTarget(
      await this.port.action(this.snapshot.id, { action: "resolve", from, raw, kind }),
    );
  }
  /** 仅读取任务已包含的有限大小资源；大附件通过原生 copy 流式处理。 */
  async read(path: string): Promise<Uint8Array> {
    const file = this.snapshot.files.find((item) => item.path === path);
    if (!file) throw new Error(`文件未被导出任务收集：${path}`);
    return readVerified(join(this.snapshot.sourceDirectory, file.path), file, this.control);
  }
  /** 仅载入登记过的中间图片；整个任务不在内存中持有整库图片字节。 */
  async readOutput(path: string): Promise<Uint8Array> {
    const expected = this.outputs.get(path);
    if (!expected) throw new Error(`产物不属于当前任务：${path}`);
    return readVerified(join(this.snapshot.outputDirectory, path), expected, this.control);
  }
  /** 原始附件不经 JavaScript 整块复制。 */
  async copy(source: string, path: string): Promise<void> {
    await this.port.action(this.snapshot.id, { action: "copy", source, path });
    const file = this.snapshot.files.find((item) => item.path === source);
    if (!file) throw new Error("复制源未出现在快照中");
    this.outputs.set(path, file);
  }
  /** 写入本次任务的一项产物；resource 为下载资源，需要计入源预算。 */
  async write(path: string, bytes: Uint8Array, resource = false): Promise<void> {
    await this.port.action(this.snapshot.id, { action: "write", path, resource }, bytes);
    this.outputs.set(path, {
      bytes: bytes.byteLength,
      hash: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  /** 保留原格式空目录。 */
  async directory(path: string): Promise<void> {
    await this.port.action(this.snapshot.id, { action: "directory", path });
  }
  /** 复核原始文件版本，随后转换只使用不可变副本。 */
  async seal(): Promise<void> {
    this.snapshot = parseExportSnapshot(
      await this.port.action(this.snapshot.id, { action: "seal" }),
    );
  }
  /** 先捕获目标当前版本；返回是否存在文件，宿主据此展示绑定此版本的覆盖确认。 */
  async target(path: string): Promise<boolean> {
    const value = await this.port.action(this.snapshot.id, { action: "target", path });
    if (!record(value) || typeof value.exists !== "boolean")
      throw new Error("无法核实导出目标身份");
    return value.exists;
  }
  /** 根据已验证的最终引用保留产物，自包含 PDF/DOCX 无需额外携带中间图片。 */
  async retain(paths: string[]): Promise<void> {
    await this.port.action(this.snapshot.id, { action: "retain", paths });
  }
  /** 原生校验全部产物并原子提交；仅单个自包含产物允许直接输出。 */
  async publish(single: string | null): Promise<{ path: string; warning: string | null }> {
    try {
      return publication(await this.port.action(this.snapshot.id, { action: "publish", single }));
    } catch (error) {
      let outcome: unknown;
      try {
        outcome = await this.port.action(this.snapshot.id, { action: "outcome" });
        if (outcome !== null) {
          const verified = publication(outcome);
          return {
            ...verified,
            warning: [verified.warning, `提交回复异常，已核实结果生成：${errorText(error)}`]
              .filter(Boolean)
              .join("；"),
          };
        }
      } catch (verification) {
        this.preserveEvidence = true;
        throw new Error(
          `无法核实导出提交结果，已保留恢复凭据，请检查目标文件：${errorText(error)}；${errorText(verification)}`,
        );
      }
      throw error;
    }
  }
  /** 取消或完成后释放任务；清理错误不应覆盖已经成功提交的结果。 */
  async dispose(): Promise<void> {
    await this.port.action(this.snapshot.id, {
      action: this.preserveEvidence ? "preserve" : "discard",
    });
  }
}

function publication(value: unknown): { path: string; warning: string | null } {
  if (
    !record(value) ||
    typeof value.path !== "string" ||
    !isAbsolute(value.path) ||
    value.path.includes("\0") ||
    (value.warning !== null && typeof value.warning !== "string")
  )
    throw new Error("无法核实导出提交结果，请检查目标文件");
  return { path: value.path, warning: value.warning };
}

/** 读取上限在分配前和循环中同时生效；暂存文件被替换时也不能无限分配。 */
async function readVerified(
  path: string,
  expected: { bytes: number; hash: string },
  control: NativeControl,
): Promise<Uint8Array> {
  if (expected.bytes >= EXPORT_LIMITS.memoryBytes)
    throw new Error("载入该正文或渲染资源将超过 2 GiB 内存预算");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size !== expected.bytes)
      throw new Error(`冻结文件大小发生变化：${path}`);
    const buffer = Buffer.alloc(expected.bytes + 1);
    const digest = createHash("sha256");
    let count = 0;
    while (count < buffer.length) {
      if (control.cancelled) throw new Error("导出已取消");
      const { bytesRead } = await file.read(
        buffer,
        count,
        Math.min(64 * 1024, buffer.length - count),
      );
      if (!bytesRead) break;
      digest.update(buffer.subarray(count, count + bytesRead));
      count += bytesRead;
    }
    const bytes = buffer.subarray(0, count);
    if (count !== expected.bytes || digest.digest("hex") !== expected.hash)
      throw new Error(`冻结文件内容发生变化：${path}`);
    return bytes;
  } finally {
    await file.close();
  }
}
