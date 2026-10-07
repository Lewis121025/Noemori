import { expect, it } from "vitest";
import {
  articleConversationHref,
  articleMarkers,
  articlePrompt,
  locateArticle,
} from "../../../../modules/notes/packages/desktop/src/features/agent/shared/article";
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
