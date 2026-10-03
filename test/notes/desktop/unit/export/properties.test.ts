import { describe, expect, it } from "vitest";
import { exportOutputNames, encodePath } from "@reader/main/export/documents";
import { findBlockPmPos, sliceEmbed } from "@reader/shared/markdown/block-anchor";
import { parseMarkdown } from "@reader/shared/markdown/parse";

/** 固定种子便于复现；所有期望来自路径和块身份的不变量，不反向调用转换器。 */
function random(seed: number): () => number {
  let state = seed;
  return () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
}

describe("EXP-PROPERTY 固定种子的名称和锚点不变量", () => {
  it("一千组目录、扩展名、大小写及 Unicode 冲突保持闭合且与选择顺序无关", () => {
    const next = random(20261003);
    const names = ["A", "a", "é", "e\u0301", "中文 # % (1)", "📝", "a.pdf", "a.MD"];
    for (let sample = 0; sample < 1000; sample++) {
      const files = new Set<string>();
      for (let i = 0; i < 12; i++)
        files.add(
          `${names[next() % names.length]}/${names[next() % names.length]}-${next() % 4}.md`,
        );
      const selected = [...files];
      const directories = ["A.PDF", "a.pdf", `空目录-${sample}`];
      const result = exportOutputNames(selected, "pdf", directories);
      expect([
        ...exportOutputNames([...selected].reverse(), "pdf", [...directories].reverse()),
      ]).toEqual([...result]);
      const outputs = [...result.values()].map((value) => value.normalize("NFC").toLowerCase());
      expect(new Set(outputs).size).toBe(outputs.length);
      for (const file of selected) {
        const output = result.get(file);
        if (!output) throw new Error(`丢失样本 ${sample} 的 ${file}`);
        expect(output).toMatch(/^documents\//);
        const normalized = output.normalize("NFC").toLowerCase();
        expect(outputs.some((other) => other.startsWith(normalized + "/"))).toBe(false);
        expect(encodePath(output).split("/").map(decodeURIComponent).join("/")).toBe(output);
        expect(new URL(encodePath(output), "https://offline.test/root/").pathname).toContain(
          "/root/documents/",
        );
      }
    }
  });

  it("一千组复杂块引用只切取标记的完整兄弟块，前后内容不混入", () => {
    const next = random(3102026);
    for (let sample = 0; sample < 1000; sample++) {
      const marker = `target-${sample}`;
      const label = `独立内容${next()}`;
      const blocks = [
        `${label}`,
        `- ${label}\n- 第二项`,
        `> ${label}\n>\n> 第二段`,
        `| 头 |\n| - |\n| ${label} |`,
        `\`\`\`txt\n${label}\n\`\`\``,
      ];
      const block = blocks[next() % blocks.length];
      if (!block) throw new Error("缺少固定种子样本");
      const doc = parseMarkdown(`# 前言${sample}\n\n${block}\n\n^${marker}\n\n后记${sample}\n`);
      const expected = doc.child(1);
      const position = findBlockPmPos(doc, marker);
      expect(position).toBe(doc.child(0).nodeSize);
      expect(sliceEmbed(doc, `^${marker}`)?.firstChild?.eq(expected)).toBe(true);
      expect(sliceEmbed(doc, `^${marker}`)?.childCount).toBe(1);
      expect(findBlockPmPos(doc, `${marker}-absent`)).toBeNull();
    }
  });
});
