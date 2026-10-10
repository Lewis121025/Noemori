/// <reference types="svelte" />
/// <reference types="vite/client" />

import type { NoemoriApi } from "../shared/api";

declare global {
  interface Element {
    /** Electron 已支持的原子移动接口；补齐当前 TypeScript DOM 声明，保留 iframe 与焦点状态。 */
    moveBefore(node: Node, child: Node | null): void;
  }

  interface Window {
    /**
     * 经 contextBridge 注入的内核调用入口。
     *
     * 渲染进程只能通过该对象访问主进程。
     */
    noemori: NoemoriApi;
  }
}

export {};
