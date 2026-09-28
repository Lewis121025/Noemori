/**
 * 为 PDF 嵌入提供视口监听；公式、HTML 与图片打开即渲染，不随滚动卸载。
 */

type VisibilityListener = (visible: boolean) => void;

const listeners = new Map<Element, VisibilityListener>();
let observer: IntersectionObserver | null = null;
let observerCtor: typeof IntersectionObserver | undefined;

function handleEntries(entries: IntersectionObserverEntry[]): void {
  for (const entry of entries) {
    const listener = listeners.get(entry.target);
    if (listener !== undefined) {
      listener(entry.isIntersecting);
    }
  }
}

function getObserver(): IntersectionObserver {
  if (observer !== null && observerCtor === globalThis.IntersectionObserver) {
    return observer;
  }
  observerCtor = globalThis.IntersectionObserver;
  observer = new IntersectionObserver(handleEntries, {
    root: null,
    // 提前一截开始排版，滚动时少空白。
    rootMargin: "400px 0px",
    threshold: 0,
  });
  return observer;
}

/**
 * 公式尚未排好时的可读 TeX 源，不跑 MathJax。
 *
 * @param tex TeX 源。
 * @param display 是否块级。
 * @returns `$...$` 或 `$$...$$`。
 */
export function mathPlaceholderText(tex: string, display: boolean): string {
  return display ? `$$${tex}$$` : `$${tex}$`;
}

/**
 * 监听元素是否进入视口（含滚动容器裁剪）。
 *
 * 无 `IntersectionObserver` 时视为始终可见，避免预览消失。
 *
 * @param element 要观察的节点。
 * @param onChange 可见性变化；同一状态可能连报，调用方自行幂等。
 * @returns 取消观察。
 */
export function observeViewport(element: Element, onChange: VisibilityListener): () => void {
  if (typeof IntersectionObserver === "undefined") {
    onChange(true);
    return () => {};
  }
  listeners.set(element, onChange);
  getObserver().observe(element);
  return () => {
    listeners.delete(element);
    observer?.unobserve(element);
  };
}
