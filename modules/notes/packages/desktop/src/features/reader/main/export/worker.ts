import { isUint8Array } from "node:util/types";
import { parentPort } from "node:worker_threads";
import { parseExportSource } from "./source-parser";
import { errorText, ExportFailure } from "./errors";
import { computeExport } from "./computation";
import { exportByteTransfer } from "./transfer";

const port = parentPort;
if (!port) throw new Error("导出解析必须在工作线程启动");
port.on("message", async (request: unknown) => {
  if (
    typeof request !== "object" ||
    request === null ||
    !("id" in request) ||
    typeof request.id !== "number" ||
    !Number.isSafeInteger(request.id) ||
    request.id < 1 ||
    Object.keys(request).length !== 2 ||
    "bytes" in request === "computation" in request ||
    ("bytes" in request && !isUint8Array(request.bytes))
  )
    throw new Error("导出解析请求无效");
  try {
    const value =
      "bytes" in request && isUint8Array(request.bytes)
        ? parseExportSource(request.bytes)
        : "computation" in request
          ? await computeExport(request.computation)
          : undefined;
    if (isUint8Array(value)) {
      const { bytes, transfer } = exportByteTransfer(value);
      port.postMessage({ id: request.id, value: bytes }, transfer);
    } else port.postMessage({ id: request.id, value }, []);
  } catch (error) {
    port.postMessage({
      id: request.id,
      error: error instanceof ExportFailure ? { issues: error.issues } : errorText(error),
    });
  }
});
