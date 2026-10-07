import { expect, it } from "vitest";
import { branchCheckpoint } from "../../../../modules/agent/node/index.js";

it("原生检查点的结构错误不把私有字段原文交给界面", async () => {
  const checkpoint = JSON.stringify({
    version: 2,
    workspace: "/workspace",
    history: [{ role: "private-checkpoint-signature", content: [{ type: "text", value: "内容" }] }],
    messages: [],
    run: null,
    pending_note: null,
    turns: [],
  });
  await expect(branchCheckpoint(checkpoint)).rejects.toThrow("对话检查点格式无效");
});
