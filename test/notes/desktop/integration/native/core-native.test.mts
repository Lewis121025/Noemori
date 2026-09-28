import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "vitest";
import { Worker } from "node:worker_threads";
import { CoreClient } from "../../../../../modules/notes/packages/desktop/src/main/core-client";
import type { SearchQuery, VaultEvent } from "../../../../../modules/notes/packages/desktop/src/features/reader/shared/api";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const workerUrl = new URL("../../../../../modules/notes/packages/desktop/out/main/core-worker.js", import.meta.url);
const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array | null): string => {
  assert.ok(data, "此场景应返回文件内容");
  return new TextDecoder().decode(data);
};

async function search(core: CoreClient, query: SearchQuery) {
  return (await core.call("searchQuery", query, randomUUID(), null)).hits;
}

test("单篇命中按需读取，与文件续页并行，取消后迟到展开不能复活旧会话", async (t) => {
  const {
    roots: [root],
    start,
  } = await fixture(t);
  await Promise.all(
    ["a.md", "b.md", "c.md"].map((path) => writeFile(join(root, path), "needle\n".repeat(26))),
  );
  const { core } = start();
  await core.call("vaultOpen", root);
  const query: SearchQuery = { expr: { kind: "term", value: "needle" }, limit: 2 };
  const first = await core.call("searchQuery", query, "same-session", null);
  assert.equal(first.hits.length, 2);
  for (const hit of first.hits) {
    assert.equal(hit.matchCount, 26);
    assert.equal(hit.matches.length, 5);
    assert.ok(hit.matchesCursor);
  }
  assert.ok(first.nextCursor);
  const cursors = first.hits.map((hit) => {
    assert.ok(hit.matchesCursor);
    return hit.matchesCursor;
  });
  const expansions = cursors.map((cursor) =>
    core.call("searchMatches", query, "same-session", cursor),
  );
  const files = core.call("searchQuery", query, "same-session", first.nextCursor);
  const pages = await Promise.all(expansions);
  assert.equal((await files).hits.length, 1);
  for (const page of pages) {
    assert.equal(page.matches.length, 20);
    assert.ok(page.nextCursor);
    const last = await core.call("searchMatches", query, "same-session", page.nextCursor);
    assert.equal(last.matches.length, 1);
    assert.equal(last.matches[0]?.location?.line, 26);
    assert.equal(last.nextCursor, null);
  }
  const latest = core.call("searchQuery", query, "new-session", null);
  await assert.rejects(
    core.call("searchMatches", query, "same-session", cursors[0]!),
    /搜索已取消/,
  );
  assert.equal((await latest).hits.length, 2);
  await core.call("searchCancel", "new-session");
  await assert.rejects(core.call("searchMatches", query, "new-session", cursors[0]!), /搜索已取消/);
});

for (const mode of ["stop", "throw", "reenter"]) {
  test(`原生移动批次 ${mode} 保留提交数、刷新索引并释放回调状态`, async (t) => {
    const {
      roots: [root],
      userData,
    } = await fixture(t);
    await mkdir(join(root, "archive"));
    await Promise.all([
      writeFile(join(root, "a.md"), "[b](./b.md)\n"),
      writeFile(join(root, "b.md"), "[a](./a.md)\n"),
    ]);
    // 独立进程的硬超时可以捕获原生锁重入死锁，不让整套测试跟随阻塞。
    const script = `
      const assert = require("node:assert/strict");
      const native = require(process.argv[1]);
      const mode = process.argv[4];
      native.vaultOpen(process.argv[2], process.argv[3], () => {});
      try {
        const changes = ["a.md", "b.md"].map(from => ({ from, to: "archive/" + from }));
        const seen = [];
        const outcome = native.entryRenameBatch(changes, completed => {
          seen.push(completed);
          if (completed === 0) return true;
          if (mode === "throw") throw new Error("observer failed");
          if (mode === "reenter") native.vaultClose();
          return false;
        });
        assert.deepEqual(seen, [0, 1]);
        assert.equal(outcome.completed, 1);
        assert.equal(outcome.warning, undefined);
        if (mode === "stop") assert.equal(outcome.issue, undefined);
        else assert.match(outcome.issue.message, mode === "throw" ? /observer failed/ : /不能重新调用内核/);
        assert.equal(native.indexLinksTo("archive/a.md").length, 1);
        assert.deepEqual(native.vaultList(), ["archive/a.md", "b.md"]);
        const retried = native.entryRenameBatch(changes.slice(outcome.completed), () => true);
        assert.equal(retried.completed, 1);
        assert.equal(retried.issue, undefined);
        assert.equal(native.indexLinksTo("archive/b.md").length, 1);
        assert.equal(Buffer.from(native.fileRead("archive/a.md")).toString(), "[b](./b.md)\\n");
      } finally { native.vaultClose(); }
    `;
    await promisify(execFile)(
      process.execPath,
      [
        "-e",
        script,
        fileURLToPath(new URL("../../../../../modules/notes/packages/vault-node/index.js", import.meta.url)),
        root,
        userData,
        mode,
      ],
      { timeout: 10000 },
    );
  });
}

test("真实异步搜索允许保存并响应取消、替换、切库与停机", async (t) => {
  const { roots: [root, other], start } = await fixture(t);
  await Promise.all(Array.from({ length: 32 }, (_, index) => writeFile(join(root, `${index}.md`), "a".repeat(128_000))));
  await writeFile(join(other, "other.md"), "otherword");
  const { core } = start();
  await core.call("vaultOpen", root);
  const slow: SearchQuery = { expr: { kind: "or", children: [
    { kind: "term", value: `${"a".repeat(1024)}b` }, { kind: "regex", value: "absent" },
  ] }, limit: 100 };
  const pending = core.call("searchQuery", slow, "cancel-me", null);
  const cancelled = assert.rejects(pending, /搜索已取消/);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const saved = await core.call("fileWrite", "saved.md", bytes("savedword"), null);
  assert.equal(saved.status, "saved");
  await core.call("searchCancel", "cancel-me");
  await cancelled;

  const replaced = assert.rejects(core.call("searchQuery", slow, "old-query", null), /搜索已取消/);
  const latest = core.call("searchQuery", { expr: { kind: "term", value: "savedword" }, limit: 10 }, "new-query", null);
  await core.call("searchCancel", "old-query");
  assert.deepEqual((await latest).hits.map((hit) => hit.path), ["saved.md"]);
  await replaced;

  const switched = assert.rejects(core.call("searchQuery", slow, "old-vault", null), /搜索已取消/);
  await core.call("vaultOpen", other);
  await switched;
  assert.deepEqual((await search(core, { expr: { kind: "term", value: "otherword" }, limit: 10 })).map((hit) => hit.path), ["other.md"]);

  await core.call("vaultOpen", root);
  const stopped = assert.rejects(core.call("searchQuery", slow, "closing", null), /搜索已取消/);
  const write = core.call("fileWrite", "final.md", bytes("finalword"), null);
  await core.shutdown();
  assert.equal((await write).status, "saved");
  await stopped;
  assert.equal(await readFile(join(root, "final.md"), "utf8"), "finalword");
}, 20000);

test("原生分页无重复，版本变化拒绝旧游标", async (t) => {
  const { roots: [root], start } = await fixture(t);
  await Promise.all(Array.from({ length: 7 }, (_, index) => writeFile(join(root, `${index}.md`), index === 6 ? "量子" : "archive")));
  const { core } = start();
  await core.call("vaultOpen", root);
  const query: SearchQuery = { expr: { kind: "or", children: [
    { kind: "term", value: "archive" }, { kind: "term", value: "量子" },
  ] }, limit: 3 };
  const first = await core.call("searchQuery", query, "paging", null);
  assert.equal(first.hits.length, 3);
  assert.ok(first.nextCursor);
  const second = await core.call("searchQuery", query, "paging", first.nextCursor);
  assert.equal(second.hits.length, 3);
  assert.ok(second.nextCursor);
  const last = await core.call("searchQuery", query, "paging", second.nextCursor);
  assert.equal(last.hits.length, 1);
  assert.equal(last.nextCursor, null);
  assert.equal(new Set([...first.hits, ...second.hits, ...last.hits].map((hit) => hit.path)).size, 7);
  await core.call("fileWrite", "new.md", bytes("archive"), null);
  await assert.rejects(core.call("searchQuery", query, "paging", first.nextCursor), /笔记库已更新/);
});

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "nous-core-worker-"));
  const clients: CoreClient[] = [];
  t.onTestFinished(async () => {
    try {
      await Promise.all(clients.map((client) => client.shutdown()));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  const roots = [join(dir, "first"), join(dir, "second")] as const;
  await Promise.all(roots.map((root) => mkdir(root)));
  const userData = join(dir, "state");
  return {
    roots,
    userData,
    start() {
      const events: VaultEvent[] = [];
      const core = new CoreClient(new Worker(workerUrl, { workerData: userData }), (event) => {
        events.push(event);
      });
      clients.push(core);
      return { core, changes: () => events.length, events };
    },
  };
}

test.skipIf(process.platform === "win32")(
  "库内反斜杠文件名经线程、索引、监视与副本返回后仍指向同一文件",
  async (t) => {
    const {
      roots: [root],
      start,
    } = await fixture(t);
    const literal = "group\\note.md";
    const nested = "group/note.md";
    await mkdir(join(root, "group"));
    await Promise.all([
      writeFile(join(root, literal), "literal"),
      writeFile(join(root, nested), "nested"),
      writeFile(join(root, "ref.md"), "[literal](./group%5Cnote.md) [nested](./group/note.md)\n"),
    ]);
    const { core, events } = start();
    await core.call("vaultOpen", root);
    assert.deepEqual(await core.call("vaultList"), [nested, literal, "ref.md"]);
    assert.deepEqual(await core.call("linksResolve", "ref.md", "./group%5Cnote.md", "md"), {
      status: "resolved",
      path: literal,
      anchor: null,
    });
    assert.equal((await core.call("indexLinksTo", literal)).length, 1);
    assert.equal((await core.call("indexLinksTo", nested)).length, 1);
    await writeFile(join(root, literal), "external");
    for (
      let attempt = 0;
      attempt < 60 && !events.some((event) => event.paths.includes(literal));
      attempt++
    )
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(events.some((event) => event.status === "changed" && event.paths.includes(literal)));
    assert.deepEqual(await core.call("fileWrite", literal, bytes("edited"), bytes("external")), {
      status: "saved",
      warning: null,
    });
    const copy = await core.call("fileWriteCopy", literal, bytes("copy"), bytes("edited"));
    assert.equal(copy.path, "group\\note (副本).md");
    assert.equal(copy.warning, null);
    assert.equal(text(await core.call("fileRead", copy.path)), "copy");
    assert.deepEqual(await core.call("entryRename", literal, "renamed.md"), { warning: null });
    assert.equal(text(await core.call("fileRead", "renamed.md")), "edited");
    assert.equal(text(await core.call("fileRead", nested)), "nested");
    assert.equal(
      text(await core.call("fileRead", "ref.md")),
      "[literal](./renamed.md) [nested](./group/note.md)\n",
    );
  },
);

test("built worker preserves directory entries, current paths and safe file operation boundaries", async (t) => {
  const {
    roots: [root],
    start,
  } = await fixture(t);
  const { core, changes } = start();
  await core.call("vaultOpen", root);
  assert.deepEqual(await core.call("entryCreate", "项目", "directory"), { warning: null });
  assert.deepEqual(await core.call("vaultEntries"), [{ path: "项目", kind: "directory" }]);
  await core.call("entryCreate", "项目/笔记.md", "file");
  await core.call("fileWrite", "项目/笔记.md", bytes("saved note"), bytes(""));
  await core.call("readerSessionPatch", {
    documents: { panes: [{ currentPath: "项目/笔记.md", history: { back: [], forward: [] } }], active: 0, split: false },
  });
  assert.deepEqual(await core.call("entryRename", "项目", "资料"), { warning: null });
  assert.deepEqual(await core.call("vaultEntries"), [
    { path: "资料", kind: "directory" },
    { path: "资料/笔记.md", kind: "file" },
  ]);
  assert.equal(
    (await core.call("readerSessionLoad")).documents.panes[0]?.currentPath,
    "资料/笔记.md",
  );
  assert.equal(
    await realpath(await core.call("entryPath", "资料/笔记.md")),
    await realpath(join(root, "资料/笔记.md")),
  );
  assert.equal(text(await core.call("fileRead", "资料/笔记.md")), "saved note");
  assert.ok(changes() >= 3);
  await assert.rejects(core.call("entryCreate", "资料/笔记.md", "file"));
  await assert.rejects(core.call("entryCreate", "../outside.md", "file"));
  await assert.rejects(core.call("entryTrash", "."));
  assert.equal(text(await core.call("fileRead", "资料/笔记.md")), "saved note");
});

test("映射失败的编辑恢复数据穿过原生线程，重开仍可读取且不改写原文", async (t) => {
  const { roots: [root], start } = await fixture(t);
  const { core } = start();
  await core.call("vaultOpen", root);
  await core.call("entryCreate", "note.md", "file");
  const source = bytes("原文\r\n");
  await core.call("fileWrite", "note.md", source, bytes(""));
  const editor = JSON.stringify({ format: "nous.prosemirror", version: 1, revision: 3, doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "math_inline", attrs: { tex: "" } }] }] } });
  await core.call("filePreserveDraft", "note.md", source, source, editor);
  await core.call("vaultClose");
  await core.call("vaultOpen", root);
  assert.deepEqual(await core.call("fileSnapshot", "note.md"), { disk: source, draft: { bytes: source, base: source, editor } });
  await assert.rejects(core.call("entryRename", "note.md", "new.md"), /未保存草稿/);
  assert.deepEqual(await core.call("fileRead", "note.md"), source);
  await assert.rejects(core.call("filePreserveDraft", "note.md", source, source, "invalid"));
  assert.equal((await core.call("fileSnapshot", "note.md")).draft?.editor, editor);
});

test("附件字节穿过原生线程，独占导入并阻止迟到请求写入新库", async (t) => {
  const { roots: [root, second], start } = await fixture(t);
  const { core } = start();
  await core.call("vaultOpen", root);
  await core.call("entryCreate", "资料", "directory");
  await core.call("entryCreate", "资料/笔记.md", "file");
  const binary = new Uint8Array([0, 255, 13, 10]);
  const first = await core.call("attachmentImport", root, "资料/笔记.md", "图片 #1.png", binary);
  assert.deepEqual(first, { path: "资料/attachments/图片 #1.png", warning: null });
  const copy = await core.call("attachmentImport", root, "资料/笔记.md", "图片 #1.png", binary);
  assert.equal(copy.path, "资料/attachments/图片 #1 (1).png");
  assert.deepEqual(await core.call("fileRead", first.path), binary);
  assert.deepEqual(
    await core.call("linksResolve", "资料/笔记.md", "./attachments/%E5%9B%BE%E7%89%87%20%231.png", "md"),
    { status: "resolved", path: first.path, anchor: null },
  );
  await assert.rejects(core.call("attachmentImport", root, "资料/笔记.md", "../outside.png", binary));
  await core.call("vaultOpen", second);
  await core.call("entryCreate", "资料", "directory");
  await core.call("entryCreate", "资料/笔记.md", "file");
  await assert.rejects(core.call("attachmentImport", root, "资料/笔记.md", "late.png", binary), /笔记库已切换/);
  assert.deepEqual(await core.call("vaultList"), ["资料/笔记.md"]);
});

test("索引故障穿过原生监视通道，正文提交仍返回真实成功与警告", async (t) => {
  const {
    roots: [root],
    userData,
    start,
  } = await fixture(t);
  await writeFile(join(root, "note.md"), "old");
  const { core, events } = start();
  await core.call("vaultOpen", root);
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 16);
  const database = new DatabaseSync(join(userData, "vaults", hash, "index.sqlite"));
  try {
    database.exec("DROP TABLE links");
  } finally {
    database.close();
  }
  await writeFile(join(root, "note.md"), "external");
  for (
    let attempt = 0;
    attempt < 60 && !events.some((event) => event.status === "index-error");
    attempt++
  )
    await new Promise((resolve) => setTimeout(resolve, 50));
  const failure = events.find((event) => event.status === "index-error");
  assert.ok(failure);
  assert.ok(failure.paths.includes("note.md"));
  const result = await core.call("fileWrite", "note.md", bytes("saved"), bytes("external"));
  assert.equal(result.status, "saved");
  assert.equal(await readFile(join(root, "note.md"), "utf8"), "saved");
  if (result.status === "saved") assert.ok(result.warning?.includes("索引"));
});

test("built worker preserves native save, conflict, copy, rename and link contracts", async (t) => {
  const {
    roots: [root],
    start,
  } = await fixture(t);
  await writeFile(join(root, "a.md"), "original");
  await writeFile(join(root, "ref.md"), "[[a]]\n");
  const { core } = start();
  assert.equal(await core.call("vaultOpen", root), root);
  assert.deepEqual(await core.call("linksResolve", "ref.md", "a", "wiki"), {
    status: "resolved",
    path: "a.md",
    anchor: null,
  });
  assert.deepEqual(await core.call("linksResolve", "ref.md", "missing", "wiki"), { status: "dead" });
  const links = await core.call("indexLinksTo", "a.md");
  assert.ok(links[0]);
  assert.equal(links[0].fromPath, "ref.md");
  assert.equal(links[0].kind, "wiki");
  const mentions = await core.call("indexMentionsTo", "a.md");
  assert.equal(mentions.linked[0]?.fromPath, "ref.md");
  assert.equal(mentions.linked[0]?.linkKind, "wiki");

  const content = bytes("saved");
  const baseline = bytes("original");
  assert.deepEqual(await core.call("fileWrite", "a.md", content, baseline), {
    status: "saved",
    warning: null,
  });
  assert.equal(text(content), "saved");
  assert.equal(text(baseline), "original");
  const conflict = await core.call("fileWrite", "a.md", bytes("draft"), bytes("original"));
  assert.equal(conflict.status, "conflict");
  assert.equal(text(conflict.disk), "saved");
  const snapshot = await core.call("fileSnapshot", "a.md");
  assert.ok(snapshot.draft);
  assert.equal(text(snapshot.disk), "saved");
  assert.equal(text(snapshot.draft.bytes), "draft");
  assert.equal(text(snapshot.draft.base), "original");
  const copy = await core.call("fileWriteCopy", "a.md", bytes("draft"), bytes("original"));
  assert.equal(copy.warning, null);
  assert.equal(text(await core.call("fileRead", copy.path)), "draft");
  assert.deepEqual(await core.call("entryRename", "a.md", "b.md"), { warning: null });
  assert.equal(text(await core.call("fileRead", "ref.md")), "[[b]]\n");
  const renamedMentions = await core.call("indexMentionsTo", "b.md");
  assert.equal(renamedMentions.linked[0]?.toRaw, "b");
  await assert.rejects(core.call("fileRead", "absent.md"));
  assert.equal(text(await core.call("fileRead", "b.md")), "saved");

  // 创建携带初始内容：同一独占事务提交；目录携带内容在写盘前拒绝。
  await core.call("entryCreate", "种子.md", "file", bytes("# 计划\n\n"));
  assert.equal(text(await core.call("fileRead", "种子.md")), "# 计划\n\n");
  await assert.rejects(
    core.call("entryCreate", "带内容目录", "directory", bytes("x")),
  );
});

test("queued writes stay in their original vault and shutdown drains the final save", async (t) => {
  const {
    roots: [first, second],
    start,
  } = await fixture(t);
  await Promise.all([first, second].map((root) => writeFile(join(root, "a.md"), "original")));
  const { core } = start();
  await core.call("vaultOpen", first);
  const saveFirst = core.call("fileWrite", "a.md", bytes("first saved"), bytes("original"));
  const openSecond = core.call("vaultOpen", second);
  const readSecond = core.call("fileRead", "a.md");
  const saveSecond = core.call("fileWrite", "a.md", bytes("second saved"), bytes("original"));
  const remember = core.call("readerSessionPatch", {
    documents: { panes: [{ currentPath: "a.md", history: { back: [], forward: [] } }], active: 0, split: false },
    filesCollapsed: true,
    leftWidth: 240,
  });
  const stopped = core.shutdown();
  const [firstResult, , secondBytes, secondResult] = await Promise.all([
    saveFirst,
    openSecond,
    readSecond,
    saveSecond,
    remember,
    stopped,
  ]);
  assert.equal(firstResult.status, "saved");
  assert.equal(text(secondBytes), "original");
  assert.equal(secondResult.status, "saved");
  assert.equal(await readFile(join(first, "a.md"), "utf8"), "first saved");
  assert.equal(await readFile(join(second, "a.md"), "utf8"), "second saved");

  const { core: restored } = start();
  assert.deepEqual(await restored.call("vaultRestore"), {
    root: second,
    documents: { panes: [{ currentPath: "a.md", history: { back: [], forward: [] } }], active: 0, split: false },
    viewModes: {},
    recentFiles: [],
    fileTree: null,
  });
  assert.equal((await restored.call("readerSessionLoad")).filesCollapsed, true);
  const panes = await restored.call("readerSessionLoad");
  assert.equal(panes.leftWidth, 240);
  assert.equal(text(await restored.call("fileRead", "a.md")), "second saved");
});

test("failed vault switches retain the active vault and previous session", async (t) => {
  const {
    roots: [first, second],
    userData,
    start,
  } = await fixture(t);
  await writeFile(join(first, "a.md"), "first");
  await writeFile(join(second, "a.md"), "second");
  const { core } = start();
  await core.call("vaultOpen", first);
  await core.call("readerSessionPatch", { documents: { panes: [{ currentPath: "a.md", history: { back: [], forward: [] } }], active: 0, split: false } });
  await assert.rejects(core.call("vaultOpen", join(second, "missing")));
  assert.equal(text(await core.call("fileRead", "a.md")), "first");
  const session = await core.call("readerSessionLoad");
  assert.equal(session.vaultRoot, first);
  assert.equal(session.documents.panes[0]?.currentPath, "a.md");

  const sessionPath = join(userData, "session.json");
  await rm(sessionPath);
  await mkdir(sessionPath);
  await assert.rejects(core.call("vaultOpen", second));
  assert.equal(text(await core.call("fileRead", "a.md")), "first");
});

test("未链接提及经原生线程就地转链接，过期区间被拒绝", async (t) => {
  const {
    roots: [root],
    start,
  } = await fixture(t);
  await Promise.all([
    writeFile(join(root, "目标.md"), "# 目标\n"),
    writeFile(join(root, "ref.md"), "开头 目标 结尾\n"),
  ]);
  const { core } = start();
  await core.call("vaultOpen", root);

  const mentions = await core.call("indexMentionsTo", "目标.md");
  const unlinked = mentions.unlinked[0];
  assert.ok(unlinked);
  assert.equal(unlinked.toRaw, "目标");
  assert.deepEqual(
    await core.call(
      "mentionsLinkify",
      "ref.md",
      unlinked.startByte,
      unlinked.endByte,
      "目标",
      "目标.md",
    ),
    { warning: null },
  );
  assert.equal(text(await core.call("fileRead", "ref.md")), "开头 [[目标]] 结尾\n");

  // 同一区间再来一次：内容已变，必须拒绝且不再改写。
  await assert.rejects(
    core.call("mentionsLinkify", "ref.md", unlinked.startByte, unlinked.endByte, "目标", "目标.md"),
  );
  assert.equal(text(await core.call("fileRead", "ref.md")), "开头 [[目标]] 结尾\n");

  const after = await core.call("indexMentionsTo", "目标.md");
  assert.equal(after.unlinked.length, 0);
  assert.equal(after.linked.length, 1);
});

test("链接消歧候选与标题锚点穿过原生解析", async (t) => {
  const {
    roots: [root],
    start,
  } = await fixture(t);
  await Promise.all([mkdir(join(root, "a")), mkdir(join(root, "b"))]);
  await Promise.all([
    writeFile(join(root, "a/foo.md"), "# A\n\n## 深入小节\n\n正文。\n"),
    writeFile(join(root, "b/foo.md"), "# B\n"),
    writeFile(join(root, "ref.md"), "[[foo]] [[a/foo#深入小节]] [[#本地]]\n"),
  ]);
  const { core } = start();
  await core.call("vaultOpen", root);

  // 裸名多义返回全部候选，不静默取一。
  assert.deepEqual(await core.call("linksResolve", "ref.md", "foo", "wiki"), {
    status: "ambiguous",
    candidates: ["a/foo.md", "b/foo.md"],
    anchor: null,
  });
  // 路径形式消歧并分离锚点。
  assert.deepEqual(await core.call("linksResolve", "ref.md", "a/foo#深入小节", "wiki"), {
    status: "resolved",
    path: "a/foo.md",
    anchor: "深入小节",
  });
  // 纯锚点链接指向源文件自身。
  assert.deepEqual(await core.call("linksResolve", "ref.md", "#本地", "wiki"), {
    status: "resolved",
    path: "ref.md",
    anchor: "本地",
  });
  // Markdown 锚点按 URL 规则百分号解码。
  assert.deepEqual(await core.call("linksResolve", "ref.md", "./a/foo.md#%E6%B7%B1%E5%85%A5%20x", "md"), {
    status: "resolved",
    path: "a/foo.md",
    anchor: "深入 x",
  });
  // 歧义链接在索引里保持死链语义，路径形式可以入图。
  const links = await core.call("indexLinksFrom", "ref.md");
  const bare = links.find((link) => link.toRaw === "foo");
  const pathForm = links.find((link) => link.toRaw === "a/foo#深入小节");
  assert.equal(bare?.toPath, null);
  assert.equal(pathForm?.toPath, "a/foo.md");
});

test("检索与标题索引穿过原生线程，中文短词、标签与属性谓词可用", async (t) => {
  const {
    roots: [root],
    start,
  } = await fixture(t);
  const source = "---\nstatus: draft\ntags: [project]\n---\n\n# 设计笔记\n\n这是全文检索的正文 #inline-tag\n\n## 第二小节\n";
  await Promise.all([
    writeFile(join(root, "note.md"), source),
    writeFile(join(root, "other.md"), "# 其它\n\n无关正文\n"),
  ]);
  const { core } = start();
  await core.call("vaultOpen", root);

  const term = (value: string) => ({ expr: { kind: "term" as const, value }, limit: 100 });
  const tag = (value: string) => ({ expr: { kind: "tag" as const, value }, limit: 100 });
  // 长词使用带位置的三字片段；标题命中具有更高排名权重。
  const fulltext = await search(core, term("全文检索"));
  assert.deepEqual(
    fulltext.map((hit) => hit.path),
    ["note.md"],
  );
  assert.ok(fulltext[0]?.snippet.includes("全文检索"));
  assert.equal(fulltext[0]?.title, "设计笔记");
  assert.match(fulltext[0]?.contentHash ?? "", /^[a-f0-9]{64}$/);
  const location = fulltext[0]?.matches[0]?.location;
  assert.ok(location);
  assert.equal(
    Buffer.from(source).subarray(location.startByte, location.endByte).toString(),
    "全文检索",
  );
  assert.equal(location.line, 8);
  // 1 字中文短词走单字倒排，结果一致。
  const short = await search(core, term("笔"));
  assert.deepEqual(
    short.map((hit) => hit.path),
    ["note.md"],
  );
  // 标签谓词：frontmatter 与行内标签同表可查。
  for (const name of ["project", "inline-tag", "#PROJECT"]) {
    const hits = await search(core, tag(name));
    assert.deepEqual(
      hits.map((hit) => hit.path),
      ["note.md"],
      `标签 ${name} 应命中`,
    );
  }
  // 属性谓词大小写不敏感。
  const byAttribute = await search(core, {
    expr: { kind: "attr", key: "STATUS", value: "Draft" },
    limit: 100,
  });
  // 表达式树穿过原生线程：OR、取反与正则组合。
  const composed = await search(core, {
    expr: {
      kind: "or",
      children: [
        { kind: "regex", value: "无关正." },
        { kind: "and", children: [{ kind: "term", value: "笔记" }, { kind: "not", child: { kind: "term", value: "无关" } }] },
      ],
    },
    limit: 100,
  });
  assert.deepEqual(composed.map((hit) => hit.path).sort(), ["note.md", "other.md"]);
  await assert.rejects(
    search(core, { expr: { kind: "regex", value: "(" }, limit: 100 }),
    /正则表达式无效/,
  );
  assert.deepEqual(
    byAttribute.map((hit) => hit.path),
    ["note.md"],
  );
  // 全库标签清单：面板组树的数据源，标签升序。
  assert.deepEqual(await core.call("indexTags"), [
    { tag: "inline-tag", count: 1 },
    { tag: "project", count: 1 },
  ]);
  // 标题索引供锚点解析与补全。
  const headings = await core.call("indexHeadings", "note.md");
  assert.deepEqual(
    headings.map((heading) => [heading.level, heading.text]),
    [
      [1, "设计笔记"],
      [2, "第二小节"],
    ],
  );
  assert.ok(headings[0] && headings[0].endByte > headings[0].startByte);
  // 笔记身份供快速切换器：文首一级标题作为展示标题。
  const noteKeys = await core.call("indexNoteKeys");
  assert.deepEqual(
    noteKeys.map((note) => [note.path, note.title]),
    [
      ["note.md", "设计笔记"],
      ["other.md", "其它"],
    ],
  );

  // 保存后派生索引增量更新：旧词消失、新词可查、标题与标签同步。
  assert.deepEqual(await core.call("fileWrite", "note.md", bytes("# 设计笔记\n\n重写之后的正文\n"), bytes(source)), {
    status: "saved",
    warning: null,
  });
  assert.deepEqual(await search(core, term("全文检索")), []);
  assert.deepEqual(
    (await search(core, term("重写之后"))).map((hit) => hit.path),
    ["note.md"],
  );
  assert.deepEqual(await search(core, tag("project")), []);
  assert.deepEqual(
    (await core.call("indexHeadings", "note.md")).map((heading) => heading.text),
    ["设计笔记"],
  );
});

test("native bookmarks round-trip through the worker and follow renames", async (t) => {
  const {
    roots: [root],
    start,
  } = await fixture(t);
  const { core } = start();
  await core.call("vaultOpen", root);
  assert.deepEqual(await core.call("bookmarksList"), []);
  await core.call("entryCreate", "notes", "directory");
  await writeFile(join(root, "notes", "a.md"), "# 甲\n");
  await core.call("bookmarksSet", [
    { kind: "file", path: "notes/a.md", title: null },
    { kind: "heading", path: "notes/a.md", heading: "甲", title: "标题" },
    { kind: "search", query: "tag:#x", title: null },
  ]);
  assert.deepEqual(await core.call("entryRename", "notes", "archive"), { warning: null });
  assert.deepEqual(await core.call("bookmarksList"), [
    { kind: "file", path: "archive/a.md", title: null },
    { kind: "heading", path: "archive/a.md", heading: "甲", title: "标题" },
    { kind: "search", query: "tag:#x", title: null },
  ]);
  // 书签是点目录里的用户数据，不能出现在文件树或全文索引里。
  assert.deepEqual(await core.call("vaultList"), ["archive/a.md"]);
  await core.shutdown();
});

test("native graph crosses the worker with aggregated edges and optional dead nodes", async (t) => {
  const {
    roots: [root],
    start,
  } = await fixture(t);
  const { core } = start();
  await writeFile(join(root, "a.md"), "# 甲\n\n#主题 [[b]] [[b#节]] [[未写]]\n");
  await writeFile(join(root, "b.md"), "[[a]]\n");
  await core.call("vaultOpen", root);
  assert.deepEqual(await core.call("indexGraph", false), {
    nodes: [
      { path: "a.md", title: "甲", tags: ["主题"], dead: false },
      { path: "b.md", title: "b", tags: [], dead: false },
    ],
    edges: [
      { from: "a.md", to: "b.md", count: 2 },
      { from: "b.md", to: "a.md", count: 1 },
    ],
  });
  const withDead = await core.call("indexGraph", true);
  assert.deepEqual(withDead.nodes.at(-1), { path: "未写", title: "未写", tags: [], dead: true });
  assert.deepEqual(withDead.edges.at(1), { from: "a.md", to: "未写", count: 1 });
  await core.shutdown();
});

test("native watcher refreshes the active vault and releases it on close", async (t) => {
  const {
    roots: [root],
    start,
  } = await fixture(t);
  const { core, changes } = start();
  await core.call("vaultOpen", root);
  await writeFile(join(root, "new.md"), "[[other]]\n");
  for (let attempt = 0; attempt < 60 && changes() === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(changes() > 0, "原生监视回调应穿过工作线程");
  assert.deepEqual(await core.call("vaultList"), ["new.md"]);
  const links = await core.call("indexLinksFrom", "new.md");
  assert.ok(links[0]);
  assert.equal(links[0].toRaw, "other");
  assert.equal(links[0].toPath, null);
  await core.call("vaultClose");
  const changesAtClose = changes();
  await writeFile(join(root, "late.md"), "late");
  await core.shutdown();
  assert.equal(changes(), changesAtClose);
});
