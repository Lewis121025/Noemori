import type { MessageMedia } from "./api";
import type { AttachmentUpload } from "./attachments";
import type { ContentPreview } from "./content";
import { remoteContentUrl } from "./content";

/** 可展示的原生媒体；云存储引用不会被误当成可直接访问的网页地址。 */
export type RenderedMedia =
  | { type: "image"; file: AttachmentUpload; preview: ContentPreview }
  | { type: "audio" | "video"; mime: string; file: AttachmentUpload | null; url: string | null };

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function bytes(value: unknown, limit: number): Uint8Array {
  if (Array.isArray(value)) {
    if (
      !value.length ||
      value.length > limit ||
      value.some(
        (byte: unknown) =>
          typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255,
      )
    )
      throw new Error("媒体字节无效或超过预览预算");
    return Uint8Array.from(value);
  }
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > Math.ceil(limit / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  )
    throw new Error("媒体编码无效");
  const raw = atob(value);
  if (raw.length > limit) throw new Error("媒体超过预览预算");
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

/** @param url 主进程交付的内嵌图片；@returns 图片字节与 MIME；@throws 格式或编码非法时拒绝。 */
export function inlineImageBytes(url: string): { bytes: Uint8Array; mime: string } | null {
  const match = /^data:(image\/(?:png|jpeg|svg\+xml));base64,([\s\S]+)$/u.exec(url);
  return match ? { mime: match[1]!, bytes: bytes(match[2], 25 * 1024 * 1024) } : null;
}

function isMedia(value: unknown): value is MessageMedia {
  return (
    object(value) &&
    (value["type"] === "image" || value["type"] === "audio" || value["type"] === "video")
  );
}

/**
 * @param media 已保留的原生内容块；图片兼容旧字节数组，音视频保留原来的字节或 URL。
 * @returns 明确格式的展示资源，图片与原生协议共用 PNG/JPEG 字节。
 * @throws 损坏、超限、格式或来源暂不支持时拒绝，由界面保留文本并提示。
 */
export function renderMessageMedia(media: unknown): RenderedMedia {
  if (!isMedia(media) || !object(media.value)) throw new Error("媒体内容无法读取");
  const value = media.value,
    format = value["format"];
  if (media.type === "image") {
    if (format !== "png" && format !== "jpeg") throw new Error("图片格式不受支持");
    const data = bytes(value["data"], 5 * 1024 * 1024);
    const prefix = format === "png" ? [137, 80, 78, 71, 13, 10, 26, 10] : [255, 216, 255];
    if (!prefix.every((byte, index) => data[index] === byte))
      throw new Error("图片内容与格式不一致");
    let encoded = typeof value["data"] === "string" ? value["data"] : "";
    if (!encoded) {
      let raw = "";
      for (let index = 0; index < data.length; index += 8192)
        raw += String.fromCharCode(...data.subarray(index, index + 8192));
      encoded = btoa(raw);
    }
    return {
      type: "image",
      file: { name: `图片.${format === "jpeg" ? "jpg" : "png"}`, bytes: data },
      preview: { type: "image", url: `data:image/${format};base64,${encoded}` },
    };
  }
  const formats: Record<string, string> =
    media.type === "audio"
      ? {
          wav: "audio/wav",
          mp3: "audio/mpeg",
          aac: "audio/aac",
          m4a: "audio/mp4",
          mp4: "audio/mp4",
          ogg: "audio/ogg",
          opus: "audio/ogg",
          flac: "audio/flac",
          webm: "audio/webm",
        }
      : { mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime" };
  const mime = typeof format === "string" ? formats[format] : undefined;
  const source = value["source"];
  if (!mime || !object(source)) throw new Error("媒体格式暂不能直接播放");
  if (source["type"] === "bytes")
    return {
      type: media.type,
      mime,
      file: {
        name: `${media.type === "audio" ? "音频" : "视频"}.${String(format)}`,
        bytes: bytes(source["value"], 25 * 1024 * 1024),
      },
      url: null,
    };
  if (source["type"] === "url" && typeof source["value"] === "string") {
    const url = remoteContentUrl(source["value"]);
    if (url) return { type: media.type, mime, file: null, url };
  }
  throw new Error("这个媒体来源暂不能直接播放");
}
