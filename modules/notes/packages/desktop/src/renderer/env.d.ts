/// <reference types="svelte" />
/// <reference types="vite/client" />

import type { NousApi } from "../shared/api";

declare global {
  interface Window {
    /**
     * 经 contextBridge 注入的内核调用入口。
     *
     * 渲染进程只能通过该对象访问主进程。
     */
    nous: NousApi;
  }
}

export {};
