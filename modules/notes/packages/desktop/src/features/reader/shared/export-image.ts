import { imageSize } from "image-size";
import { EXPORT_LIMITS } from "./export";

/**
 * 解码前检查文件头、声明类型与像素预算；浏览器完整解码仍须随后成功。
 * @throws 损坏头部、伪造 MIME、过大尺寸或不支持的格式时拒绝分配图像内存。
 */
export function checkExportImage(bytes: Uint8Array, mime: string): void {
  if (!bytes.byteLength || bytes.byteLength >= EXPORT_LIMITS.memoryBytes)
    throw new Error("图片为空或超过任务内存预算");
  const dimensions = imageSize(bytes);
  const expected =
    dimensions.type === "svg"
      ? "image/svg+xml"
      : dimensions.type === "jpg"
        ? "image/jpeg"
        : `image/${dimensions.type}`;
  if (mime.toLowerCase() !== expected)
    throw new Error(`图片类型声明与内容不一致：${mime} / ${expected}`);
  for (const { width, height } of [dimensions, ...(dimensions.images ?? [])]) {
    if (
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width < 1 ||
      height < 1 ||
      width > EXPORT_LIMITS.imageEdge ||
      height > EXPORT_LIMITS.imageEdge ||
      Math.ceil(width) * Math.ceil(height) > EXPORT_LIMITS.imagePixels
    )
      throw new Error("图片解码尺寸超过预算，请使用 SVG 或缩小图片");
  }
}
