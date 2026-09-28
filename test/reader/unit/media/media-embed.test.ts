import { describe, expect, it, vi } from "vitest";
import { parseMarkdown, serializeMarkdown } from "@reader/renderer/engine/markdown/markdown";
import { previewKindFromReference, vaultMediaUrl } from "@reader/renderer/engine/media/media";
import { playerSource } from "@reader/renderer/engine/rendering/media-view";

function inlineTypes(source: string): string[] {
  const out: string[] = [];
  parseMarkdown(source).descendants((node) => {
    if (node.isInline) out.push(node.type.name);
  });
  return out;
}

describe("音视频嵌入", () => {
  it("按扩展名识别音频与视频，wiki 与 Markdown 两种写法都成为播放器节点", () => {
    expect(previewKindFromReference("a.MP3?t=1")).toBe("audio");
    expect(previewKindFromReference("clip.webm#x")).toBe("video");
    expect(previewKindFromReference("doc.pdf")).toBe("pdf");
    expect(inlineTypes("![[录音.m4a]] 与 ![片段](media/v.mp4)")).toEqual([
      "audio",
      "text",
      "video",
    ]);
  });

  it("往返保留原始写法", () => {
    for (const source of ["![[录音.m4a|会议]]\n", '![片段](media/v%201.mp4 "标题")\n']) {
      expect(serializeMarkdown(parseMarkdown(source))).toBe(source);
    }
  });

  it("播放器地址：远程原样使用，库内文件走流式协议并逐段编码，解析失败为 null", async () => {
    const io = {
      resolveLink: vi.fn(async (_from: string, raw: string) =>
        raw === "missing.mp3" ? null : "音频/会议 1.mp3",
      ),
    };
    expect(await playerSource("a.md", "https://x/y.mp3", "md", io)).toBe("https://x/y.mp3");
    expect(await playerSource("a.md", "会议 1.mp3", "wiki", io)).toBe(
      vaultMediaUrl("音频/会议 1.mp3"),
    );
    expect(vaultMediaUrl("音频/会议 1.mp3")).toBe(
      `nous-vault://vault/${encodeURIComponent("音频")}/${encodeURIComponent("会议 1.mp3")}`,
    );
    expect(await playerSource("a.md", "missing.mp3", "wiki", io)).toBeNull();
    expect(await playerSource("a.md", "  ", "wiki", io)).toBeNull();
  });
});
