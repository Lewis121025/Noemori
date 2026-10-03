/**
 * 按链接目标选择嵌入预览；真实磁盘路径应直接使用 mimeFromPath。
 * @param src Markdown 或 Wiki 引用，可带查询参数和片段。
 * @returns 可预览的嵌入类型；其他目标返回 null。
 */
export function previewKindFromReference(src: string): "image" | "pdf" | "audio" | "video" | null {
  const path = src.split(/[?#]/, 1)[0] ?? src;
  return previewKindFromMime(mimeFromPath(path));
}

/** 按 MIME 选择嵌入节点；附件插入与链接解析共用同一规则。 */
export function previewKindFromMime(mime: string): "image" | "pdf" | "audio" | "video" | null {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return mime === "application/pdf" ? "pdf" : null;
}

/**
 * 由真实文件扩展名选择 MIME，不将文件名里的 #、? 解释成 URL 后缀。
 * @param path 库内相对路径。
 * @returns 已支持的 MIME；其他类型返回 application/octet-stream。
 */
export function mimeFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "avif":
      return "image/avif";
    case "bmp":
      return "image/bmp";
    case "pdf":
      return "application/pdf";
    case "mp3":
      return "audio/mpeg";
    case "wav":
      return "audio/wav";
    case "m4a":
      return "audio/mp4";
    case "ogg":
      return "audio/ogg";
    case "flac":
      return "audio/flac";
    case "mp4":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "mov":
      return "video/quicktime";
    case "ogv":
      return "video/ogg";
    default:
      return "application/octet-stream";
  }
}
