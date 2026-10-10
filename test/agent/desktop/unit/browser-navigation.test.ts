import { expect, it } from "vitest";
import { browserAddress, parseBrowserNavigation, parseBrowserPlacement } from "../../../../modules/notes/packages/desktop/src/features/agent/shared/browser";

it("地址栏支持网址、域名、带端口的本机站点与中文搜索", () => {
  expect(browserAddress("example.com/path")).toBe("https://example.com/path");
  expect(browserAddress("localhost:3000/settings")).toBe("http://localhost:3000/settings");
  expect(browserAddress("http://127.0.0.1:3000/")).toBe("http://127.0.0.1:3000/");
  expect(new URL(browserAddress("中文搜索")).searchParams.get("q")).toBe("中文搜索");
});
it("网页和 IPC 不能通过地址栏执行脚本、读取本机文件或选择未知动作", () => {
  for (const url of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,test", "https://name:secret@example.com/"])
    expect(() => browserAddress(url)).toThrow();
  expect(() => parseBrowserNavigation({ action: "evaluate", page: "page", code: "test" })).toThrow();
  expect(() => parseBrowserPlacement({ page: "page", human: true, bounds: { x: NaN, y: 0, width: 10, height: 10 } })).toThrow();
});
