/**
 * 图谱布局 Worker：按时间片推进 d3-force，每片结束送回一帧坐标。
 *
 * 同一时间只跑一个布局；新请求直接取代旧请求，旧请求不再回帧。
 */

import { LayoutRun } from "./layout";
import type { LayoutRequestMessage, LayoutFrameMessage } from "./layout-client";

/** 单个时间片的计算预算；留出余量让坐标帧及时到达主线程。 */
const SLICE_MS = 12;

let current: { id: number; run: LayoutRun } | null = null;

function pump(id: number): void {
  const job = current;
  if (job === null || job.id !== id) return;
  const started = performance.now();
  let done = job.run.done;
  while (!done && performance.now() - started < SLICE_MS) done = job.run.step(1);
  const positions = job.run.positions();
  const frame: LayoutFrameMessage = { id, positions, done };
  self.postMessage(frame, { transfer: [positions.buffer] });
  if (done) current = null;
  else setTimeout(() => pump(id), 0);
}

self.onmessage = (event: MessageEvent<LayoutRequestMessage>) => {
  const message = event.data;
  if (message.type === "stop") {
    if (current?.id === message.id) current = null;
    return;
  }
  current = { id: message.id, run: new LayoutRun(message.request) };
  pump(message.id);
};
