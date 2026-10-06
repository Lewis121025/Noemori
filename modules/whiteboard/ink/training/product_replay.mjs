import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

/** 回放固定验证笔迹的真实停笔状态机；快照漂移或预测缺失直接失败，不参与选样。 */
async function replay(samplesPath, predictions) {
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  const samples = fs.readFileSync(samplesPath, "utf8").trim().split("\n").map(JSON.parse);
  const server = await createServer({
    root,
    configFile: false,
    optimizeDeps: { noDiscovery: true, entries: [] },
    server: { middlewareMode: true, watch: null, hmr: false },
  });
  try {
    const { WhiteboardInput } = await server.ssrLoadModule(
      root + "modules/notes/packages/desktop/src/features/reader/renderer/whiteboard/input.ts",
    );
    const { emptyWhiteboard } = await server.ssrLoadModule(
      root + "modules/notes/packages/desktop/src/features/reader/shared/whiteboard/model.ts",
    );
    const results = [];
    for (const sample of samples) {
      let digest = null;
      const input = new WhiteboardInput(
        emptyWhiteboard(),
        () => {},
        async (snapshot) => {
          digest = crypto
            .createHash("sha256")
            .update(JSON.stringify([snapshot.map((point) => [point.x, point.y])]))
            .digest("hex");
          if (digest !== sample.snapshot_sha256 || !predictions[digest])
            throw new Error("产品验证快照已漂移或预测缺失：" + sample.sample_id);
          return predictions[digest];
        },
      );
      const points = sample.paths[0].map(([x, y]) => ({ x, y, pressure: 0.5 }));
      const time = (i) =>
        sample.timestamps_seconds ? sample.timestamps_seconds[i] * 1000 : undefined;
      input.begin(points[0], false, time(0));
      for (let i = 1; i < points.length; i++) input.update(points[i], false, time(i));
      await input.hold();
      if (digest !== sample.snapshot_sha256) throw new Error("产品验证触发行为已漂移");
      results.push({
        sample_id: sample.sample_id,
        source: sample.source,
        truth: sample.label,
        label: input.correctedLabel,
      });
    }
    return results;
  } finally {
    await server.close();
  }
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const results = await replay(process.argv[2], JSON.parse(Buffer.concat(chunks).toString("utf8")));
process.stdout.write(JSON.stringify(results));
