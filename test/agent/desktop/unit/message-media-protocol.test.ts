import { expect, it } from "vitest";
import type {
  MessageMedia,
  MessagePart,
} from "../../../../modules/notes/packages/desktop/src/features/agent/shared/api";
import { parseSnapshot } from "../../../../modules/notes/packages/desktop/src/features/agent/shared/parse";

function parts(content: unknown[], role: "user" | "tool" = "tool"): MessagePart[] {
  return parseSnapshot(
    JSON.stringify({
      id: "media-session",
      workspace: "/workspace",
      revision: 1,
      closed: false,
      run: null,
      turns: [],
      messages: [{ role, content }],
      approvals: [],
      terminals: [],
      browser: { status: "idle", tabs: [], receipts: [], error: null },
    }),
  ).messages.flatMap((message) => message.content);
}

function tool(fields: Record<string, unknown>): unknown {
  return {
    type: "tool_result",
    value: { call_id: "capture", name: "browser", output: {}, is_error: false, ...fields },
  };
}

const image = {
  format: "png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
};
const media: MessageMedia[] = [
  { type: "image", value: image },
  { type: "audio", value: { format: "wav", source: { type: "bytes", value: [1, 2] } } },
  {
    type: "video",
    value: { format: "mp4", source: { type: "url", value: "https://example.com/video.mp4" } },
  },
];

it("普通内容和工具结果保留相同的媒体类型、载荷与顺序", () => {
  expect(parts(media, "user")).toEqual(media);
  expect(parts([tool({ media })])).toMatchObject([{ value: { media } }]);
});

it.each(["image", "audio", "video"])("普通媒体 %s 缺少载荷时在解析入口拒绝", (type) => {
  expect(() => parts([{ type }], "user")).toThrow("载荷");
});

it.each(["image", "audio", "video"])("工具媒体 %s 缺少载荷时在解析入口拒绝", (type) => {
  expect(() => parts([tool({ media: [{ type }] })])).toThrow("载荷");
});

it.each([
  { item: { type: "pdf", value: {} } },
  { item: { type: null, value: {} } },
  { item: { value: {} } },
  { item: "image" },
  { item: [] },
])("非法工具媒体封装被拒绝：%j", ({ item }) => {
  expect(() => parts([tool({ media: [item] })])).toThrow();
});

it("旧图片只在工具结果读取边界迁移，带类型的旧字段同样保留顺序", () => {
  expect(parts([tool({ images: [image, media[1], media[2]] })])).toMatchObject([
    { value: { media } },
  ]);
  expect(() => parts([image], "user")).toThrow();
});

it("缺省或空媒体没有伪造内容，重复字段即使为空也不能静默择一", () => {
  for (const fields of [{}, { media: [] }, { images: [] }]) {
    const [part] = parts([tool(fields)]);
    expect(part).toMatchObject({ type: "tool_result" });
    expect(part?.value).not.toHaveProperty("media");
  }
  expect(() => parts([tool({ media: [], images: [] })])).toThrow("重复");
});

it.each([null, {}, "broken", 0, false])("错误媒体数组不回退为空：%j", (media) => {
  expect(() => parts([tool({ media })])).toThrow();
});
