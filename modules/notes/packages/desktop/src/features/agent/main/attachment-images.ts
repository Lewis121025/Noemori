import { nativeImage } from "electron";
import { imageSize } from "image-size";

/**
 * 将可识别的栅格图规范成原生协议支持的 PNG/JPEG，文件附件保留原始副本。
 * @param bytes 已冻结且不超过附件预算的原始文件。
 * @returns 规范图片；非图片返回 null。
 * @throws 图片损坏、解码尺寸超过预算或规范后仍超过 5 MiB 时拒绝。
 */
export function attachmentImage(bytes: Buffer): { format: "png" | "jpeg"; bytes: Buffer } | null {
  const recognized = bytes.subarray(0, 12);
  const raster =
    recognized.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    recognized.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ||
    recognized.subarray(0, 3).toString() === "GIF" ||
    (recognized.subarray(0, 4).toString() === "RIFF" &&
      recognized.subarray(8, 12).toString() === "WEBP") ||
    recognized.subarray(0, 2).toString() === "BM";
  if (!raster) return null;
  const size = imageSize(bytes);
  if (!size.width || !size.height || size.width * size.height > 32 * 1024 * 1024)
    throw new Error("图片损坏或超过 3200 万像素");
  // 文件头只能给出尺寸；实际解码成功后才能把附件声明为模型可用图片。
  let image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) throw new Error("图片无法解码，请转换为 PNG 或 JPEG");
  if (
    (size.type === "png" || size.type === "jpg") &&
    size.width <= 4096 &&
    size.height <= 4096 &&
    bytes.length <= 5 * 1024 * 1024
  )
    return { format: size.type === "png" ? "png" : "jpeg", bytes };
  const ratio = Math.min(1, 4096 / Math.max(size.width, size.height));
  if (ratio < 1)
    image = image.resize({
      width: Math.max(1, Math.round(size.width * ratio)),
      height: Math.max(1, Math.round(size.height * ratio)),
      quality: "best",
    });
  const png = image.toPNG();
  if (png.length <= 5 * 1024 * 1024) return { format: "png", bytes: png };
  const jpeg = image.toJPEG(85);
  if (jpeg.length > 5 * 1024 * 1024) throw new Error("图片转换后仍超过 5 MiB，请缩小图片");
  return { format: "jpeg", bytes: jpeg };
}
