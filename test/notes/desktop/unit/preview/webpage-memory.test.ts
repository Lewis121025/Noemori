/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { webPageProtection } from "@reader/main/webpage-memory";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function candidate() {
  const execute = vi.fn(async (source: string): Promise<unknown> => window.eval(source));
  return {
    isDestroyed: () => false,
    isFocused: () => false,
    isLoading: () => false,
    isCurrentlyAudible: () => false,
    mainFrame: { framesInSubtree: [{ executeJavaScript: execute }] },
    execute,
  };
}

it("普通页面可回收，非空文本、富文本和选项变化保护用户输入", async () => {
  const page = candidate();
  expect(await webPageProtection(page)).toBe("discard");
  const field = document.createElement("input");
  field.value = "尚未提交";
  document.body.append(field);
  expect(await webPageProtection(page)).toBe("input");
  field.remove();
  const editor = document.createElement("div");
  editor.setAttribute("contenteditable", "true");
  editor.textContent = "文稿";
  document.body.append(editor);
  expect(await webPageProtection(page)).toBe("input");
  editor.remove();
  const select = document.createElement("select");
  select.innerHTML = "<option>A</option><option>B</option>";
  document.body.append(select);
  expect(await webPageProtection(page)).toBe("discard");
  select.selectedIndex = 1;
  expect(await webPageProtection(page)).toBe("input");
});
it("正在加载、聚焦、发声及静音视频播放中的网页不回收", async () => {
  for (const override of [
    { isFocused: () => true },
    { isLoading: () => true },
    { isCurrentlyAudible: () => true },
  ]) {
    const page = candidate();
    expect(await webPageProtection({ ...page, ...override })).toBe("active");
    expect(page.execute).not.toHaveBeenCalled();
  }
  const video = document.createElement("video");
  document.body.append(video);
  vi.spyOn(video, "paused", "get").mockReturnValue(false);
  expect(await webPageProtection(candidate())).toBe("active");
});
it("子框架也检查输入，未知响应和验证失败不会被当作可回收", async () => {
  const page = candidate();
  const nested = vi.fn(async (_source: string): Promise<unknown> => "input");
  page.mainFrame.framesInSubtree.push({ executeJavaScript: nested });
  expect(await webPageProtection(page)).toBe("input");
  expect(nested).toHaveBeenCalledOnce();
  page.execute.mockRejectedValueOnce(new Error("进程切换"));
  expect(await webPageProtection(page)).toBe("unknown");
  page.execute.mockResolvedValueOnce({ unexpected: true });
  expect(await webPageProtection(page)).toBe("unknown");
});

it("繁忙页面超过检查时限时保守保留，并清理等待定时器", async () => {
  vi.useFakeTimers();
  const page = candidate();
  page.execute.mockReturnValueOnce(new Promise(() => {}));
  const checking = webPageProtection(page);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await checking).toBe("unknown");
  expect(vi.getTimerCount()).toBe(0);
});
