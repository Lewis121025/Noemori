import { expect, it } from "vitest";
import { buildWorkspaceTree, workspaceTreeRows, conversationKey } from "@reader/renderer/library/workspace-tree";
import type { WorkspaceConversation } from "@reader/shared/workspace-conversations";
const chat = (id: string, patch: Partial<WorkspaceConversation> = {}): WorkspaceConversation => ({ id, title: id, workspace: "/vault", article: null, origin: null, archived: false, updatedAt: 1, status: null, ...patch });
const article = { path: "folder/note.md", title: "note", status: "located" };
const entries = [{ path: "folder/note.md", kind: "file" as const }];
it("无关联对话独立显示，分叉按对话来源排列，不生成内部工作目录节点", () => {
 const tree = buildWorkspaceTree(entries, [chat("independent", { workspace: null }), chat("branch", { workspace: null, origin: { conversationId: "independent", title: "independent", turnId: null } })], "/vault", false);
 expect(tree.map(node => node.title)).toEqual(["folder", "independent"]);
 expect(tree[1]?.children[0]?.title).toBe("branch");
 expect(tree.some(node => node.kind === "workspace")).toBe(false);
});
it("文章、分叉和独立对话按真实所属目录排列，其他库不按字符串前缀混入", () => {
 const tree = buildWorkspaceTree(entries, [chat("one", { article }), chat("fork", { article, origin: { conversationId: "one", title: "one", turnId: null } }), chat("local", { workspace: "/vault/folder" }), chat("external", { workspace: "/vault-other" })], "/vault", false);
 expect(tree[0]?.children.map(n => n.title)).toEqual(["note", "local"]);
 expect(tree[0]?.children[0]?.children[0]?.children[0]?.title).toBe("fork");
 expect(tree[1]?.title).toBe("/vault-other");
 const rows = workspaceTreeRows(tree, new Set(), "fork", new Set(), new Set());
 expect(rows.map(n => n.title)).toEqual(["folder", "note", "one", "fork"]);
 expect(rows.at(-1)?.file).toBeNull();
});
it("同路径重建文章不吸收已删除来源，对话分叉保留归档祖先", () => {
 const tree = buildWorkspaceTree(entries, [chat("old", { article: { ...article, removed: true, status: "article-missing" }, archived: true }), chat("fork", { article: { ...article, removed: true, status: "article-missing" }, origin: { conversationId: "old", title: "old", turnId: null } })], "/vault", false);
 expect(tree[0]?.children[0]?.children).toEqual([]);
 expect(tree[1]?.kind).toBe("source");
 expect(tree[1]?.children[0]?.children[0]?.key).toBe(conversationKey("fork"));
});
it("循环来源不隐藏对话，不产生无限递归", () => {
 const tree = buildWorkspaceTree([], [chat("a", { origin: { conversationId: "b", title: "b", turnId: null } }), chat("b", { origin: { conversationId: "a", title: "a", turnId: null } })], "/vault", false);
 expect(tree.map(n => n.title)).toEqual(["a", "b"]);
});

it("目录优先，文件按名称自然排序而不跟随修改时间跳动", () => {
 const tree = buildWorkspaceTree([
  { path: "第10章.md", kind: "file", modifiedAt: 3000 },
  { path: "第2章.md", kind: "file", modifiedAt: 1000 },
  { path: "资料", kind: "directory" },
 ], [], "/vault", false);
 expect(tree.map(node => node.key)).toEqual(["资料", "第2章.md", "第10章.md"]);
});
