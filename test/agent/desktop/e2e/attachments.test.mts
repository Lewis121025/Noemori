import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { expect, onTestFinished, test } from "vitest";
import { _electron as electron, type Page } from "playwright-core";
import { readConversationInput } from "../../../../modules/notes/packages/desktop/src/features/agent/shared/input";
import { attachmentFilename } from "../../../../modules/notes/packages/desktop/src/features/agent/shared/attachments";
import { record } from "../../../../modules/notes/packages/desktop/src/features/agent/shared/parse";
import type { Protocol } from "../../../../modules/notes/packages/desktop/src/features/agent/shared/api";

const desktop = new URL("../../../../modules/notes/packages/desktop/", import.meta.url);
const require = createRequire(new URL("package.json", desktop));
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
  "base64",
);

function textParts(body: unknown): string[] {
  if (typeof body === "string") return [body];
  if (Array.isArray(body)) return body.flatMap(textParts);
  if (body && typeof body === "object") return Object.values(body).flatMap(textParts);
  return [];
}

async function fixture(
  protocol: Protocol,
  respond: (body: unknown, call: number) => unknown | Promise<unknown>,
  statuses: number[] = [],
) {
  const directory = await mkdtemp(join(tmpdir(), "noemori-attachments-e2e-"));
  const requests: unknown[] = [];
  const failures: unknown[] = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(body);
      const status = statuses[requests.length - 1] ?? 200;
      if (status !== 200) {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "测试服务暂时拒绝请求" }));
        return;
      }
      const result = await respond(body, requests.length);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
    } catch (cause) {
      failures.push(cause);
      response.writeHead(400);
      response.end(String(cause));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
    expect(failures).toEqual([]);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试接口未启动");
  const executable: unknown = require("electron");
  if (typeof executable !== "string") throw new Error("Electron 未安装");
  const app = await electron.launch({
    executablePath: executable,
    args: [fileURLToPath(new URL("out/main/index.js", desktop)), `--user-data-dir=${directory}`],
    cwd: fileURLToPath(desktop),
    env: { ...process.env, NOEMORI_TEST_WINDOW: "hidden" },
  });
  onTestFinished(() => app.close());
  const page = await app.firstWindow();
  page.setDefaultTimeout(8000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForFunction(() => typeof window.noemori?.agent?.attachmentsChoose === "function");
  await page.evaluate(
    async ({ protocol, endpoint }) => {
      await window.noemori.agent.providersSave({
        id: null,
        name: "附件测试",
        protocol,
        address: { type: "endpoint", url: endpoint },
        authentication: { type: "none" },
        models: [
          {
            id: "attachment-model",
            tools: true,
            streaming: false,
            vision: null,
            audio: false,
            video: false,
          },
          {
            id: "text-only",
            tools: true,
            streaming: false,
            vision: false,
            audio: false,
            video: false,
          },
        ],
      });
    },
    { protocol, endpoint: `http://127.0.0.1:${address.port}/model` },
  );
  await page.getByRole("button", { name: "工作区助手", exact: true }).click();
  await page.getByRole("button", { name: "开始新对话", exact: true }).click();
  await page
    .getByRole("dialog", { name: "新建对话", exact: true })
    .getByRole("button", { name: "创建对话", exact: true })
    .click();
  await page.getByRole("button", { name: "选择对话模型", exact: true }).click();
  await page.getByRole("button", { name: "attachment-model", exact: true }).click();
  const id = (await page.evaluate(() => window.noemori.agent.list())).items[0]!.id;
  return { directory, requests, app, page, id };
}

async function model(page: Page, name: string) {
  await page.getByRole("button", { name: "选择对话模型", exact: true }).click();
  await page.getByRole("button", { name, exact: true }).click();
}

function answer(protocol: Protocol): unknown {
  if (protocol === "openai-responses")
    return {
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "已读取附件" }],
        },
      ],
    };
  if (protocol === "anthropic")
    return { content: [{ type: "text", text: "已读取附件" }], stop_reason: "end_turn" };
  return {
    choices: [{ message: { role: "assistant", content: "已读取附件" }, finish_reason: "stop" }],
  };
}

function toolCall(protocol: Protocol, arguments_: unknown, callId: string): unknown {
  if (protocol === "openai-responses")
    return {
      status: "completed",
      output: [
        {
          type: "function_call",
          call_id: callId,
          name: "terminal",
          arguments: JSON.stringify(arguments_),
        },
      ],
    };
  if (protocol === "anthropic")
    return {
      content: [{ type: "tool_use", id: callId, name: "terminal", input: arguments_ }],
      stop_reason: "tool_use",
    };
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: callId,
              type: "function",
              function: { name: "terminal", arguments: JSON.stringify(arguments_) },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  };
}

function terminalObservation(value: unknown): { status: string; id: string } | null {
  try {
    const output = record(record(value)["output"]);
    return typeof output["status"] === "string" && typeof output["session_id"] === "string"
      ? { status: output["status"], id: output["session_id"] }
      : null;
  } catch {
    return null;
  }
}

function lastTerminal(body: unknown): { status: string; id: string } | null {
  for (const value of textParts(body).reverse()) {
    try {
      const observation = terminalObservation(JSON.parse(value));
      if (observation) return observation;
    } catch {
      /* 模型请求的普通文字不是工具结果。 */
    }
  }
  return null;
}

test.each(["openai-chat", "openai-responses", "anthropic"] as const)(
  "%s 的真实窗口上传、预览、重载与模型请求完整接通，终端读到冻结的文件副本",
  async (protocol) => {
    const { app, page, directory, requests, id } = await fixture(protocol, (body, call) => {
      if (call > 1) {
        const terminal = lastTerminal(body);
        if (terminal?.status === "running")
          return toolCall(
            protocol,
            { action: "poll", session_id: terminal.id, yield_time_ms: 1000 },
            `read-attachment-${call}`,
          );
        return answer(protocol);
      }
      const raw = textParts(body).find(
        (text) => readConversationInput(text).attachments.length > 0,
      );
      if (!raw) throw new Error("模型未收到附件输入");
      const input = readConversationInput(raw);
      const file = input.attachments.find((file) => file.image === null)!;
      const path = `${input.directory}/${attachmentFilename(file)}`;
      return toolCall(
        protocol,
        { action: "exec", cmd: `cat '${path.replace(/'/gu, "'\\''")}'`, yield_time_ms: 1000 },
        "read-attachment",
      );
    });
    const textPath = join(directory, "资料.txt"),
      imagePath = join(directory, "图片.png");
    await writeFile(textPath, "冻结的真实附件正文");
    await writeFile(imagePath, png);
    await app.evaluate(
      ({ dialog }, paths) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths });
      },
      [textPath, imagePath],
    );
    await page.getByRole("button", { name: "添加附件", exact: true }).click();
    await page.getByRole("button", { name: "预览附件：资料.txt", exact: true }).waitFor();
    await page.getByRole("button", { name: "预览附件：资料.txt", exact: true }).click();
    const preview = page.getByRole("dialog", { name: "附件预览", exact: true });
    await preview.getByText("冻结的真实附件正文", { exact: true }).waitFor();
    await preview.getByRole("button", { name: "关闭附件预览", exact: true }).click();
    await page.getByRole("button", { name: "预览附件：图片.png", exact: true }).click();
    await expect
      .poll(() =>
        preview
          .locator("img")
          .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
      )
      .toBe(true);
    expect(await preview.locator("img").getAttribute("src")).toBe(
      `data:image/png;base64,${png.toString("base64")}`,
    );
    await preview.getByRole("button", { name: "关闭附件预览", exact: true }).click();
    await writeFile(textPath, "外部原文件已经更改");
    await page.reload();
    await page.waitForFunction(() => typeof window.noemori?.agent?.list === "function");
    if (!(await page.getByRole("textbox", { name: "Agent 用户任务", exact: true }).isVisible()))
      await page.getByRole("button", { name: "工作区助手", exact: true }).click();
    await page.getByRole("button", { name: "预览附件：图片.png", exact: true }).waitFor();
    await model(page, "text-only");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect
      .poll(() => page.locator(".agent-panel .panel-error > span").textContent())
      .toBe("当前模型不支持图片，请选择支持视觉的模型或移除图片附件");
    expect(requests).toHaveLength(0);
    expect(
      (await page.evaluate((id) => window.noemori.agent.snapshot(id), id)).draftAttachments,
    ).toHaveLength(2);
    await model(page, "attachment-model");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await expect
      .poll(
        async () =>
          (await page.evaluate((id) => window.noemori.agent.snapshot(id), id)).run?.status,
        { timeout: 20000 },
      )
      .toBe("completed");
    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(requests[0])).toContain(png.toString("base64"));
    expect(JSON.stringify(requests.slice(1))).toContain("冻结的真实附件正文");
    expect(await readFile(textPath, "utf8")).toBe("外部原文件已经更改");
    expect(await page.getByRole("list", { name: "已发送附件", exact: true }).count()).toBe(1);
    expect(
      (await page.evaluate((id) => window.noemori.agent.snapshot(id), id)).draftAttachments ?? [],
    ).toEqual([]);
  },
);

test("真实拖入和粘贴文件通过字节 IPC 导入，取消选择与移除不发起模型", async () => {
  const { app, page, requests, id } = await fixture("openai-chat", () => answer("openai-chat"));
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  });
  await page.getByRole("button", { name: "添加附件", exact: true }).click();
  expect(
    (await page.evaluate((id) => window.noemori.agent.snapshot(id), id)).draftAttachments ?? [],
  ).toEqual([]);
  await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["实际拖入的原文"], "拖入.txt", { type: "text/plain" }));
    const composer = document.querySelector("form.composer")!;
    composer.dispatchEvent(
      new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }),
    );
  });
  await page.getByRole("button", { name: "预览附件：拖入.txt", exact: true }).waitFor();
  await expect
    .poll(() => page.getByRole("button", { name: "添加附件", exact: true }).isDisabled())
    .toBe(false);
  await page.evaluate(
    (data) => {
      const clipboard = new DataTransfer();
      clipboard.items.add(new File([Uint8Array.from(data)], "粘贴.png", { type: "image/png" }));
      document.querySelector("form.composer textarea")!.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: clipboard,
        }),
      );
    },
    [...png],
  );
  await page.getByRole("button", { name: "预览附件：粘贴.png", exact: true }).waitFor();
  await page.getByRole("button", { name: "移除附件：拖入.txt", exact: true }).click();
  await page.getByRole("button", { name: "移除附件：粘贴.png", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await page.evaluate((id) => window.noemori.agent.snapshot(id), id)).draftAttachments ?? [],
    )
    .toEqual([]);
  expect(requests).toHaveLength(0);
});

test("损坏图片整批拒绝并回滚，超尺寸图片规范后可真实解码且保留原始文件", async () => {
  const { app, page, directory, requests, id } = await fixture("openai-chat", () =>
    answer("openai-chat"),
  );
  await expect(
    page.evaluate(
      ({ id, data }) =>
        window.noemori.agent.attachmentsUpload(id, [
          { name: "正文.txt", bytes: new TextEncoder().encode("不能半批导入") },
          { name: "损坏.png", bytes: Uint8Array.from(data) },
        ]),
      { id, data: [...png.subarray(0, 33)] },
    ),
  ).rejects.toThrow();
  expect(
    (await page.evaluate((id) => window.noemori.agent.snapshot(id), id)).draftAttachments ?? [],
  ).toEqual([]);
  expect(await readdir(join(directory, "agent/agent-attachments/owned", id))).toEqual([]);
  const original = await app.evaluate(
    ({ nativeImage }, data) => [
      ...nativeImage.createFromBuffer(Buffer.from(data)).resize({ width: 4200, height: 1 }).toPNG(),
    ],
    [...png],
  );
  const [file] = await page.evaluate(
    ({ id, data }) =>
      window.noemori.agent.attachmentsUpload(id, [
        { name: "大图.png", bytes: Uint8Array.from(data) },
      ]),
    { id, data: original },
  );
  const preview = await page.evaluate(
    ({ id, file }) => window.noemori.agent.attachmentPreview(id, file),
    { id, file: file!.id },
  );
  if (preview.type !== "image") throw new Error("大图未规范成图片");
  const size = await page.evaluate(async (url) => {
    const image = new Image();
    image.src = url;
    await image.decode();
    return { width: image.naturalWidth, height: image.naturalHeight };
  }, preview.url);
  expect(size).toEqual({ width: 4096, height: 1 });
  expect(
    await readFile(join(directory, "agent/agent-attachments/owned", id, attachmentFilename(file!))),
  ).toEqual(Buffer.from(original));
  expect(requests).toHaveLength(0);
});

test("排队附件在下一轮派发时才对工具可见", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  onTestFinished(release);
  const { page, directory, requests, id } = await fixture("openai-chat", async (_body, call) => {
    if (call === 1) await gate;
    return answer("openai-chat");
  });
  await page.getByRole("textbox", { name: "Agent 用户任务", exact: true }).fill("当前任务");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);
  const files = await page.evaluate(
    async ({ id, data }) =>
      window.noemori.agent.attachmentsUpload(id, [
        { name: "排队.png", bytes: Uint8Array.from(data) },
      ]),
    { id, data: [...png] },
  );
  const run = (await page.evaluate((id) => window.noemori.agent.snapshot(id), id)).run!.id;
  await page.evaluate(
    ({ id, run, file }) => window.noemori.agent.queueAdd(id, run, "下一轮查看图片", [], [file]),
    { id, run, file: files[0]!.id },
  );
  let listed = await page.evaluate(
    ({ id, path }) =>
      window.noemori.agent.terminalAction(id, {
        action: "exec",
        cmd: `ls '${path}'`,
        yield_time_ms: 1000,
      }),
    { id, path: join(directory, "agent/agent-attachments/published", id) },
  );
  let terminal = terminalObservation(listed);
  while (terminal?.status === "running") {
    listed = await page.evaluate(
      ({ id, session }) =>
        window.noemori.agent.terminalAction(id, {
          action: "poll",
          session_id: session,
          yield_time_ms: 1000,
        }),
      { id, session: terminal.id },
    );
    terminal = terminalObservation(listed);
  }
  expect(JSON.stringify(listed)).toContain('"exit_code":0');
  expect(JSON.stringify(listed)).not.toContain(attachmentFilename(files[0]!));
  release();
  await expect.poll(() => requests.length, { timeout: 20000 }).toBe(2);
  await expect
    .poll(
      async () => (await page.evaluate((id) => window.noemori.agent.snapshot(id), id)).run?.status,
    )
    .toBe("completed");
  expect(JSON.stringify(requests[0])).not.toContain(png.toString("base64"));
  expect(JSON.stringify(requests[1])).toContain(png.toString("base64"));
  expect(
    await readFile(
      join(directory, "agent/agent-attachments/published", id, attachmentFilename(files[0]!)),
    ),
  ).toEqual(png);
  const earlier = await page.evaluate(
    ({ id, run }) => window.noemori.agent.fork(id, { title: "第一轮分支", afterTurnId: run }),
    { id, run },
  );
  await expect(
    page.evaluate(({ id, file }) => window.noemori.agent.attachmentPreview(id, file), {
      id: earlier.id,
      file: files[0]!.id,
    }),
  ).rejects.toThrow("不属于");
  const current = await page.evaluate(
    (id) => window.noemori.agent.fork(id, { title: "完整分支", afterTurnId: null }),
    id,
  );
  await page.evaluate((id) => window.noemori.agent.remove(id), id);
  expect(
    await page.evaluate(({ id, file }) => window.noemori.agent.attachmentPreview(id, file), {
      id: current.id,
      file: files[0]!.id,
    }),
  ).toMatchObject({ type: "image", url: `data:image/png;base64,${png.toString("base64")}` });
});

test("图片请求自动重试和失败后手动继续保留原始附件，不重复创建用户消息", async () => {
  const { page, requests, id } = await fixture(
    "openai-chat",
    () => answer("openai-chat"),
    [503, 200, 400, 200],
  );
  const files = await page.evaluate(
    ({ id, data }) =>
      window.noemori.agent.attachmentsUpload(id, [
        { name: "重试.png", bytes: Uint8Array.from(data) },
      ]),
    { id, data: [...png] },
  );
  await page.evaluate(({ id, file }) => window.noemori.agent.start(id, "分析图片", [], [file]), {
    id,
    file: files[0]!.id,
  });
  await expect
    .poll(
      async () => (await page.evaluate((id) => window.noemori.agent.snapshot(id), id)).run?.status,
      { timeout: 20000 },
    )
    .toBe("completed");
  expect(requests).toHaveLength(2);
  expect(requests[0]).toEqual(requests[1]);
  expect(JSON.stringify(requests[1])).toContain(png.toString("base64"));
  await page.evaluate((id) => window.noemori.agent.start(id, "继续研究"), id);
  await expect
    .poll(
      async () => (await page.evaluate((id) => window.noemori.agent.snapshot(id), id)).run?.status,
    )
    .toBe("failed");
  const before = await page.evaluate((id) => window.noemori.agent.snapshot(id), id);
  expect(requests).toHaveLength(3);
  await page.evaluate(({ id, run }) => window.noemori.agent.resume(id, run), {
    id,
    run: before.run!.id,
  });
  await expect
    .poll(
      async () => (await page.evaluate((id) => window.noemori.agent.snapshot(id), id)).run?.status,
    )
    .toBe("completed");
  expect(requests).toHaveLength(4);
  expect(JSON.stringify(requests[3])).toContain(png.toString("base64"));
  const after = await page.evaluate((id) => window.noemori.agent.snapshot(id), id);
  expect(
    after.messages.filter(
      (message) =>
        message.role === "user" &&
        message.content.some(
          (part) => part.type === "text" && readConversationInput(part.value).attachments.length,
        ),
    ),
  ).toHaveLength(1);
});
