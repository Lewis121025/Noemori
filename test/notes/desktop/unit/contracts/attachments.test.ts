import { expect, it } from "vitest";
import { MAX_ATTACHMENT_BYTES, parseAttachmentReply, parseAttachmentRequest, parseImportedAttachment } from "@reader/shared/attachments";

it("IPC 拒绝伪字节和超大附件，保留合法空文件", () => {
  const bytes = new Uint8Array();
  expect(parseAttachmentRequest("/notes", "a.md", "empty.zip", bytes).bytes).toBe(bytes);
  for (const value of [null, [], [1, 2], "text", { byteLength: 1 }])
    expect(() => parseAttachmentRequest("/notes", "a.md", "a.png", value)).toThrow("有效字节");
  expect(() => parseAttachmentRequest("/notes", "a.md", "a.png", new Uint8Array(MAX_ATTACHMENT_BYTES + 1))).toThrow("64 MiB");
  expect(() => parseAttachmentRequest(null, "a.md", "a.png", bytes)).toThrow("笔记库");
});

it("提交结果必须携带安全相对路径和明确的警告状态", () => {
  expect(parseImportedAttachment({ path: "目录/attachments/a.png", warning: null })).toEqual({ path: "目录/attachments/a.png", warning: null });
  for (const result of [null, {}, { path: "a.png" }, { path: "/a.png", warning: null }, { path: "../a.png", warning: null }, { path: "dir\0a.png", warning: null }, { path: "a.png", warning: false }])
    expect(() => parseImportedAttachment(result)).toThrow("结果无效");
});

it("已提交的附件保留 Unix 父目录名中的反斜杠，不误认为目录分隔符", () => {
  const attachment = { path: "资料\\原稿/attachments/图.png", warning: null };
  expect(parseAttachmentReply({ status: "imported", attachment })).toEqual(attachment);
});

it("失败响应保留业务原因，损坏的线程结果不能冒充成功", () => {
  expect(() => parseAttachmentReply({ status: "failed", message: "attachments 已被文件占用" })).toThrow(/^attachments 已被文件占用$/);
  expect(parseAttachmentReply({ status: "imported", attachment: { path: "attachments/a.zip", warning: "索引失败" } })).toEqual({ path: "attachments/a.zip", warning: "索引失败" });
  for (const reply of [null, {}, { status: "failed", message: "" }, { status: "imported", attachment: null }])
    expect(() => parseAttachmentReply(reply)).toThrow();
});
