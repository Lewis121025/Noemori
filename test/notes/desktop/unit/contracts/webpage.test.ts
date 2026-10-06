import { expect, it } from "vitest";
import {
  intersectPageRects,
  parseWebPage,
  parseWebPageLayouts,
  parseWebPageState,
  parseWebPageUpdate,
  webPageUrl,
} from "@reader/shared/webpage";

const id = "12345678-1234-1234-1234-123456789abc";
const rect = { x: 10, y: -100, width: 640, height: 480 };
it("增量布局明确区分变化和卸载，同一身份不能在一批中重复或冲突", () => {
  const layout = { id, url: "https://example.com/", bounds: rect, clip: rect };
  expect(parseWebPageUpdate({ layouts: [layout], removed: [] })).toEqual({
    layouts: [layout],
    removed: [],
  });
  expect(parseWebPageUpdate({ layouts: [], removed: [id] })).toEqual({
    layouts: [],
    removed: [id],
  });
  for (const value of [
    [layout],
    { layouts: [layout], removed: [id] },
    { layouts: [], removed: [id, id] },
  ])
    expect(() => parseWebPageUpdate(value)).toThrow();
});
it("只接受网页协议、明确高度与无凭据入口，保留查询和片段", () => {
  expect(parseWebPage({ url: "https://example.com/中文?q=1#section", height: 240 })).toEqual({
    url: "https://example.com/%E4%B8%AD%E6%96%87?q=1#section",
    height: 240,
  });
  for (const url of [
    "file:///tmp/a",
    "data:text/html,x",
    "javascript:alert(1)",
    "noemori-vault://vault/note.md",
    "https://user:pass@example.com",
    "https:\n//example.com",
  ])
    expect(() => webPageUrl(url)).toThrow();
  for (const height of [undefined, NaN, Infinity, 239, 1201, 480.5, "480"])
    expect(() => parseWebPage({ url: "https://example.com", height })).toThrow();
});
it("主进程布局契约拒绝重复、非数值和不完整范围", () => {
  const layout = { id, url: "https://example.com", bounds: rect, clip: rect };
  expect(parseWebPageLayouts([layout])[0]?.url).toBe("https://example.com/");
  for (const value of [
    [layout, layout],
    [{ ...layout, clip: null }],
    [{ ...layout, bounds: { ...rect, x: NaN } }],
    [{ ...layout, id: "arbitrary" }],
  ])
    expect(() => parseWebPageLayouts(value)).toThrow();
  expect(parseWebPageLayouts([{ ...layout, bounds: null, clip: null }])).toHaveLength(1);
});
it("裁剪保留网页完整尺寸，离屏不产生可见区域", () => {
  expect(intersectPageRects(rect, { x: 0, y: 50, width: 800, height: 500 })).toEqual({
    x: 10,
    y: 50,
    width: 640,
    height: 330,
  });
  expect(intersectPageRects(rect, { x: 1000, y: 0, width: 100, height: 100 })).toBeNull();
});
it("状态跨 IPC 不接受非法地址或未知布尔值", () => {
  const state = {
    id,
    url: "https://example.com/",
    title: "网页",
    loading: false,
    error: null,
    canBack: false,
    canForward: true,
    focused: false,
  };
  expect(parseWebPageState(state)).toEqual(state);
  expect(() => parseWebPageState({ ...state, url: "file:///tmp/a" })).toThrow();
  expect(() => parseWebPageState({ ...state, canBack: "true" })).toThrow();
});
