import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, open, realpath, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Download } from "playwright-core";
import mime from "mime";
import type { BrowserSettings, DownloadState } from "./contract.js";
import { reason } from "./observation.js";
import { releaseBrowserResources } from "./lifecycle.js";

/** 下载暂存与上传读取共用会话工作区边界；模型不能操作浏览器内部下载路径。 */
export class BrowserFiles {
  private readonly entries = new Map<
    string,
    { state: DownloadState; path: string; download: Download }
  >();
  private readonly pending = new Set<Promise<void>>();
  private closed = false;

  /** @param settings 宿主已解析真实工作区路径的配置；不在构造期间读取文件或启动下载。 */
  constructor(private readonly settings: BrowserSettings) {}

  /**
   * 登记浏览器下载并保留完成任务；关闭后或达到数量上限时取消新下载。
   * @param download 当前上下文触发的下载。
   * @returns 立即返回；下载读取失败留在对应 DownloadState.error，不冒充完成。
   */
  receive(download: Download): void {
    if (this.closed || this.entries.size >= 100) {
      void download.cancel();
      return;
    }
    const id = randomUUID();
    const entry = {
      state: {
        id,
        name: basename(download.suggestedFilename()),
        status: "running",
        bytes: 0,
        error: null,
      } satisfies DownloadState,
      path: join(this.settings.download_directory, id),
      download,
    };
    this.entries.set(id, entry);
    const task = this.collect(id).finally(() => this.pending.delete(task));
    this.pending.add(task);
  }

  /** @returns 不含暂存路径的独立状态数组，不等待未结束的网络流。 */
  states(): DownloadState[] {
    return [...this.entries.values()].map(({ state }) => ({ ...state }));
  }

  private async collect(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    try {
      await mkdir(this.settings.download_directory, { recursive: true, mode: 0o700 });
      await entry.download.saveAs(entry.path);
      const size = (await stat(entry.path)).size;
      if (size > this.settings.max_download_bytes) {
        await unlink(entry.path);
        throw new Error("下载文件超过会话文件预算");
      }
      entry.state.bytes = size;
      entry.state.status = "completed";
    } catch (error) {
      entry.state.status = "failed";
      entry.state.error = reason(error);
    }
  }

  /**
   * 上传先打开并读取授权工作区内的普通文件，固定字节后才交给浏览器，避免网页自行读取路径。
   * @param paths 工作区相对或绝对路径；路径解析后必须仍处于授权工作区。
   * @returns 文件名、MIME 类型和固定字节；本函数不向网页上传。
   * @throws 路径越界、非普通文件、总大小超限、读取期间大小改变或文件系统错误。
   */
  async upload(paths: string[]): Promise<{ name: string; mimeType: string; buffer: Buffer }[]> {
    const result: { name: string; mimeType: string; buffer: Buffer }[] = [];
    let total = 0;
    for (const path of paths) {
      const absolute = await realpath(resolve(this.settings.workspace, path));
      this.withinWorkspace(absolute);
      const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const metadata = await file.stat();
        if (!metadata.isFile() || metadata.size > this.settings.max_download_bytes - total)
          throw new Error("上传必须是预算内的普通文件");
        const buffer = Buffer.alloc(metadata.size + 1);
        let bytesRead = 0;
        while (bytesRead < buffer.length) {
          const chunk = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
          if (chunk.bytesRead === 0) break;
          bytesRead += chunk.bytesRead;
        }
        if (bytesRead !== metadata.size) throw new Error("上传文件在读取期间发生变化");
        total += bytesRead;
        result.push({
          name: basename(absolute),
          mimeType: mime.getType(absolute) ?? "",
          buffer: buffer.subarray(0, bytesRead),
        });
      } finally {
        await file.close();
      }
    }
    return result;
  }

  /**
   * 保存已完成下载到已有工作区目录；禁止覆盖，冲突由调用方明确选择新路径。
   * @param id 当前会话分配的下载标识。
   * @param path 工作区内的目标路径，父目录必须已存在。
   * @returns 确实完成保存的绝对路径。
   * @throws 下载未完成、路径越界、目标已存在或文件系统错误。
   */
  async save(id: string, path: string): Promise<string> {
    const entry = this.entries.get(id);
    if (!entry || entry.state.status !== "completed") throw new Error("下载不存在或尚未完成");
    const destination = resolve(this.settings.workspace, path);
    const parent = await realpath(dirname(destination));
    this.withinWorkspace(parent);
    const output = join(parent, basename(destination));
    await copyFile(entry.path, output, constants.COPYFILE_EXCL);
    return output;
  }

  /**
   * 关闭时取消未完成下载并等待落盘任务结算；暂存目录由 Rust 资源所有者删除。
   * @returns 所有下载任务结算后完成，不再接收新下载。
   * @throws 浏览器取消请求失败时抛出错误；单个下载读取失败仍保留在其状态内。
   */
  async close(): Promise<void> {
    this.closed = true;
    const cancellations = await Promise.allSettled(
      [...this.entries.values()]
        .filter(({ state }) => state.status === "running")
        .map(({ download }) => download.cancel()),
    );
    const failures: unknown[] = cancellations.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    await releaseBrowserResources([
      () => {
        if (failures.length)
          throw new AggregateError(failures, `取消下载失败：${failures.map(reason).join("；")}`);
      },
      async () => {
        await Promise.all(this.pending);
      },
    ]);
  }

  private withinWorkspace(path: string): void {
    const rel = relative(this.settings.workspace, path);
    if (
      rel === ".." ||
      rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
      isAbsolute(rel)
    )
      throw new Error("文件路径不属于已授权工作区");
  }
}
