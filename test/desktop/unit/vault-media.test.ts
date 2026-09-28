import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createVaultMediaHandler,
  mediaMime,
  parseRange,
  vaultMediaPath,
} from "../../../modules/notes/packages/desktop/src/main/vault-media";

describe("媒体地址与类型", () => {
  it("只接受 vault 主机下的规范相对路径，逐段解码", () => {
    expect(vaultMediaPath("nous-vault://vault/%E9%9F%B3%E9%A2%91/a%20b.mp3")).toBe("音频/a b.mp3");
    for (const invalid of [
      "nous-vault://other/a.mp3",
      "https://vault/a.mp3",
      "nous-vault://vault/",
      "nous-vault://vault/a//b.mp3",
      "nous-vault://vault/%2E%2E/secret.mp3",
      "nous-vault://vault/a%00.mp3",
      "nous-vault://vault/%E0%A4%A.mp3",
    ])
      expect(vaultMediaPath(invalid)).toBeNull();
  });

  it("只放行音视频扩展名", () => {
    expect(mediaMime("a.MP4")).toBe("video/mp4");
    expect(mediaMime("a.flac")).toBe("audio/flac");
    expect(mediaMime("note.md")).toBeNull();
    expect(mediaMime("image.png")).toBeNull();
  });
});

describe("Range 解析", () => {
  it("区间、开放区间与后缀区间，越界起点不可满足，格式错误返回整篇", () => {
    expect(parseRange("bytes=0-9", 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange("bytes=90-", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=50-500", 100)).toEqual({ start: 50, end: 99 });
    expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=-500", 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=100-", 100)).toBe("unsatisfiable");
    expect(parseRange(null, 100)).toBeNull();
    expect(parseRange("bytes=0-1,5-6", 100)).toBeNull();
    expect(parseRange("items=0-1", 100)).toBeNull();
    expect(parseRange("bytes=9-3", 100)).toBeNull();
  });
});

describe("协议处理", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "nous-media-"));
    await writeFile(join(root, "clip.mp4"), "0123456789");
    await writeFile(join(root, "note.md"), "# 不给");
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  const resolved = (rel: string) => {
    if (rel.includes("missing")) throw new Error("越界或不存在");
    return Promise.resolve(join(root, rel));
  };

  it("整篇返回 200，区间请求返回 206 与 Content-Range", async () => {
    const handle = createVaultMediaHandler(resolved);
    const full = await handle(new Request("nous-vault://vault/clip.mp4"));
    expect(full.status).toBe(200);
    expect(full.headers.get("content-type")).toBe("video/mp4");
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    expect(await full.text()).toBe("0123456789");
    const part = await handle(
      new Request("nous-vault://vault/clip.mp4", { headers: { Range: "bytes=2-5" } }),
    );
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(part.headers.get("content-length")).toBe("4");
    expect(await part.text()).toBe("2345");
    const beyond = await handle(
      new Request("nous-vault://vault/clip.mp4", { headers: { Range: "bytes=10-" } }),
    );
    expect(beyond.status).toBe(416);
  });

  it("非媒体、越界与非法地址都拒绝，不泄露文件内容", async () => {
    const handle = createVaultMediaHandler(resolved);
    expect((await handle(new Request("nous-vault://vault/note.md"))).status).toBe(415);
    expect((await handle(new Request("nous-vault://vault/missing.mp4"))).status).toBe(404);
    // Request 会先规范化点段；上级目录在原文层由 vaultMediaPath 拒绝，库根边界由内核兜底。
    expect((await handle(new Request("nous-vault://other/clip.mp4"))).status).toBe(400);
  });
});
