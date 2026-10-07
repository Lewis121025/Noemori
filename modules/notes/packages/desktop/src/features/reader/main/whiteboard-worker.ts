import { parentPort } from "node:worker_threads";
import { parseShapeRepairRequest } from "../shared/whiteboard/recognition";
import { repairScene } from "../shared/whiteboard/fitting-scene";

if (!parentPort) throw new Error("白板几何线程缺少消息端口");
const port = parentPort;
port.on("message", (value: unknown) => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("id" in value) ||
    typeof value.id !== "number" ||
    !Number.isSafeInteger(value.id) ||
    value.id < 1 ||
    !("request" in value)
  )
    throw new Error("白板几何线程请求无效");
  try {
    port.postMessage({ id: value.id, value: repairScene(parseShapeRepairRequest(value.request)) });
  } catch (cause) {
    port.postMessage({
      id: value.id,
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }
});
