import { expect, it } from "vitest";
import {
  articleConversationHref,
  articleMarkers,
  articlePrompt,
  locateArticle,
} from "../../../../modules/notes/packages/desktop/src/features/agent/shared/article";
import {
  record,
  text,
} from "../../../../modules/notes/packages/desktop/src/features/agent/shared/parse";
const id = "11111111-1111-4111-8111-111111111111";
const binding = { path: "知识/光学.md", title: "光学", markerId: id };
const link = `[讨论](${articleConversationHref(id)})`;

it("入口从语法树定位，编辑段落后更新位置，不把代码或文字当入口", () => {
  const source = `# 光学\n\n第一段\n\n折射发生在介质交界处。${link}\n\n\`${link}\`\n\n\`\`\`md\n${link}\n\`\`\``;
  expect(articleMarkers(source)).toHaveLength(1);
  expect(locateArticle(binding, source)).toMatchObject({
    status: "located",
    line: 5,
    heading: "光学",
    paragraph: `折射发生在介质交界处。${link}`,
  });
  expect(locateArticle(binding, `新增段落\n\n${source}`).line).toBe(7);
  expect(locateArticle(binding, `${source}\n\n${link}`).status).toBe("ambiguous");
  expect(locateArticle(binding, "入口已删除").status).toBe("marker-missing");
  expect(locateArticle(binding, null).status).toBe("article-missing");
  expect(
    locateArticle(binding, `段落[讨论][入口]\n\n[入口]: ${articleConversationHref(id)}`).status,
  ).toBe("located");
});

it("提示词提供明确文件和当前位置，失效时不携带旧段落", () => {
  const prompt = articlePrompt("/笔记库", locateArticle(binding, `当前内容${link}`));
  expect(prompt).toContain('"article_path":"知识/光学.md"');
  expect(prompt).toContain('"line":1');
  expect(prompt).toContain("当前内容");
  const missing = articlePrompt("/新位置", locateArticle(binding, null));
  expect(missing).toContain('"status":"article-missing"');
  expect(missing).not.toContain("当前内容");
});

it.each(["\u0000", "😀", "汉", '"', "\\", "\n"])(
  "上下文按实际 JSON 字节预算截断 %s，保留来源与完整 Unicode",
  (character) => {
    const location = {
      ...locateArticle(binding, `当前内容${link}`),
      heading: character.repeat(20000),
      paragraph: character.repeat(20000),
    };
    const prompt = articlePrompt("/笔记库", location);
    expect(new TextEncoder().encode(prompt).length).toBeLessThanOrEqual(64 * 1024);
    const metadata = record(JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1)));
    expect(metadata).toMatchObject({
      workspace: "/笔记库",
      article_path: binding.path,
      marker_id: id,
      status: "located",
      heading_truncated: true,
      paragraph_truncated: true,
    });
    const fields: ("heading" | "paragraph")[] = ["heading", "paragraph"];
    for (const field of fields) {
      const excerpt = text(metadata, field);
      expect(excerpt.length).toBeGreaterThan(0);
      expect(excerpt.isWellFormed()).toBe(true);
      expect(location[field].startsWith(excerpt)).toBe(true);
    }
  },
);

it("段落字符上限不切开代理对，来源身份超限时明确拒绝", () => {
  const location = {
    ...locateArticle(binding, `当前内容${link}`),
    paragraph: "a".repeat(15999) + "😀",
  };
  const prompt = articlePrompt("/笔记库", location);
  const metadata: unknown = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1));
  expect(metadata).toMatchObject({
    heading: null,
    heading_truncated: false,
    paragraph: "a".repeat(15999),
    paragraph_truncated: true,
  });
  expect(() => articlePrompt("/" + "a".repeat(64 * 1024), location)).toThrow("来源元数据超过");
});
