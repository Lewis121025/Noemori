import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CoreClient } from "../../../../../modules/notes/packages/desktop/src/main/core-client";

it("EXP-COMMIT-RECOVERY 已覆盖目标、恢复凭据写失败、宿主关闭的组合仍可核实提交", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "noemori-export-commit-close-"));
  const root = join(directory, "vault");
  const state = join(directory, "state");
  await mkdir(root);
  await writeFile(join(root, "a.md"), "source");
  const clients: CoreClient[] = [];
  t.onTestFinished(async () => {
    await Promise.all(clients.map((client) => client.shutdown()));
    await rm(directory, { recursive: true, force: true });
  });
  const core = new CoreClient(state, () => {});
  clients.push(core);
  await core.call("vaultOpen", root);
  await core.call("exportPrepare", root, "close-test", null, true, core.createControl());
  await core.call(
    "exportAction",
    "close-test",
    { action: "write", path: "a.pdf", resource: false },
    new TextEncoder().encode("complete output"),
  );
  await core.call("exportAction", "close-test", { action: "seal" });
  const target = join(directory, "a.pdf");
  await writeFile(target, "old output");
  await core.call("exportAction", "close-test", { action: "target", path: target });
  const obstruction = join(state, "export-jobs/pending-close-test.json");
  await mkdir(obstruction);
  const saved = await core.call("exportAction", "close-test", {
    action: "publish",
    single: "a.pdf",
  });
  expect(saved).toMatchObject({
    path: await realpath(target),
    warning: expect.stringContaining("结果已生成"),
  });
  await core.shutdown();
  await rm(obstruction, { recursive: true });
  const reopened = new CoreClient(state, () => {});
  clients.push(reopened);
  expect(await reopened.call("exportRecover")).toEqual([
    { id: "close-test", path: await realpath(target), status: "saved" },
  ]);
  expect(await readFile(target, "utf8")).toBe("complete output");
});
