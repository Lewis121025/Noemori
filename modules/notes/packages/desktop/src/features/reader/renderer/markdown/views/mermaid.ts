/** Mermaid 完整引擎的共用入口；所有内置图表均由引擎识别并按需加载。 */
export type MermaidRenderer = (
  id: string,
  source: string,
  dark: boolean,
  signal?: AbortSignal,
) => Promise<string>;

let pending: Promise<void> = Promise.resolve();

/**
 * 串行初始化和排版，防止阅读器与对话消息并发渲染时串用全局主题配置。
 * @param id 调用方生成的页面内唯一 SVG 标识，只能含字母、数字与连字符。
 * @param source 完整 Mermaid 源码，不预先限制图表类型。
 * @param dark 是否使用深色主题。
 * @param signal 内容替换或卸载时取消；尚未开始的任务跳过布局，正在执行的库调用等待其清理完成。
 * @returns 以严格安全模式生成的 SVG；交互宿主仍需隔离模型内容。
 * @throws 取消时抛出 signal.reason；加载、语法或布局失败保留原始异常，均不阻塞后续任务。
 */
export const renderMermaid: MermaidRenderer = (id, source, dark, signal) => {
  const result = pending.then(async () => {
    signal?.throwIfAborted();
    const mermaid = (await import("mermaid")).default;
    signal?.throwIfAborted();
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: dark ? "dark" : "neutral",
      look: "classic",
      fontFamily: "system-ui, sans-serif",
      flowchart: { minNodeWidth: 32, padding: 10, nodeSpacing: 28, rankSpacing: 28 },
      suppressErrorRendering: true,
      secure: [...(mermaid.mermaidAPI.defaultConfig.secure ?? []), "suppressErrorRendering"],
    });
    const { svg } = await mermaid.render(id, source);
    signal?.throwIfAborted();
    return svg;
  });
  // 当前调用仍接收原始异常；队列尾只负责释放下一次排版。
  pending = result.then(
    () => {},
    () => {},
  );
  return result;
};
