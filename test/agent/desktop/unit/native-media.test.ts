import { expect, it } from "vitest";
import {
  inlineImageBytes,
  renderMessageMedia,
} from "../../../../modules/notes/packages/desktop/src/features/agent/shared/native-media";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
it("原生图片和旧字节数组使用相同图像，保存不会截断或重编码", () => {
  const raw = Uint8Array.from(atob(png), (character) => character.charCodeAt(0));
  for (const data of [png, Array.from(raw)]) {
    const media = renderMessageMedia({ type: "image", value: { format: "png", data } });
    expect(media).toMatchObject({
      type: "image",
      file: { bytes: raw },
      preview: { type: "image", url: `data:image/png;base64,${png}` },
    });
  }
  expect(inlineImageBytes(`data:image/png;base64,${png}`)?.bytes).toEqual(raw);
});
it("音视频字节可本地播放，外部地址不带认证，云存储引用不被猜成网页", () => {
  expect(
    renderMessageMedia({
      type: "audio",
      value: { format: "wav", source: { type: "bytes", value: [1, 2, 3] } },
    }),
  ).toMatchObject({ type: "audio", mime: "audio/wav", file: { bytes: new Uint8Array([1, 2, 3]) } });
  expect(
    renderMessageMedia({
      type: "video",
      value: { format: "mp4", source: { type: "url", value: "https://example.com/video.mp4" } },
    }),
  ).toMatchObject({ type: "video", url: "https://example.com/video.mp4", file: null });
  for (const value of ["file:///private/movie.mp4", "https://user:secret@example.com/movie.mp4"])
    expect(() =>
      renderMessageMedia({
        type: "video",
        value: { format: "mp4", source: { type: "url", value } },
      }),
    ).toThrow();
  expect(() =>
    renderMessageMedia({
      type: "audio",
      value: { format: "wav", source: { type: "gcs", value: "gs://bucket/file.wav" } },
    }),
  ).toThrow();
});
it("错误编码、越界字节、伪造格式和超限图片不能进入展示", () => {
  for (const data of ["invalid!", "aGVsbG8=", [-1], [256], [0.5], png.repeat(100_000)])
    expect(() => renderMessageMedia({ type: "image", value: { format: "png", data } })).toThrow();
  expect(() => renderMessageMedia({ type: "image", value: { format: "jpeg", data: png } })).toThrow(
    "格式",
  );
});
