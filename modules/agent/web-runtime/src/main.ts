import { pathToFileURL } from "node:url";
import { parseInput } from "./contract.js";
import { readPage, readSnapshot } from "./page.js";
import { readPdf } from "./pdf.js";
import { HostChannel } from "./channel.js";

async function main(): Promise<void> {
  // 第三方解析器的诊断只能进入 stderr，stdout 始终保持一个完整协议结果。
  console.log = (...values: unknown[]) => console.error(...values);
  const channel = new HostChannel();
  try {
    const input = parseInput(await channel.read());
    const startBrowser = (executable: string, proxyUrl: string) =>
      channel.startBrowser(executable, proxyUrl);
    if (input.operation === "search") {
      await channel.finishSearch(await readSnapshot(input, startBrowser));
    } else {
      const result =
        input.operation === "pdf"
          ? await readPdf(
              new Uint8Array(Buffer.from(input.data || "", "base64")),
              input.url,
              input.limits,
            )
          : await readPage(input, startBrowser);
      await channel.finish(result);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await channel.fail(reason);
    process.exitCode = 1;
  } finally {
    channel.close();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
