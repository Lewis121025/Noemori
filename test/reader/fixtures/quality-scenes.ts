/** 固定样本包含中文、组合字符、密集列表和保真语法；每次运行生成相同内容。 */
export const fidelityScene =
  '\uFEFF---\r\n# 保留注释与引号\r\ntitle: "思考的边界"\r\ntags: [研究, 写作]\r\n---\r\n\r\n思考的边界\r\n==========\r\n\r\n正文包括中文、English、👩‍💻 与 é。\r\n\r\n*  第一项 _强调_\r\n*  [ ] 下一步\r\n   * 嵌套的 [[参考#标题|来源]]\r\n\r\n> [!note] 一个观察\r\n> 保留引用的空白。\r\n\r\n| 名称 | 结论 |\r\n| :--- | ---: |\r\n| 资料 | 需要复核 |\r\n\r\n~~~ts title=example\r\nconst message = "原样保留";\r\n~~~~~\r\n\r\n正文 [来源][ref] 与脚注[^1]。\r\n\r\n[ref]: <参考.md>  "标题"\r\n[^1]:  脚注的原始空格\r\n\r\n未知语法 %%保留%%';

/** 1200 段固定长文，不依赖随机数或当前日期。 */
export const longDocumentScene = Array.from(
  { length: 1200 },
  (_, index) => `第 ${index + 1} 段正文，含 **重点内容**、*斜体* 和普通文字。`,
).join("\n\n");

/** 一万篇约 100 MB 的正文库，每篇包含唯一定位短语以及共同中文短词。 */
export function knowledgeNote(folder: number, file: number): string {
  const paragraph =
    "把观察变成文字，再把文字组织成可以重新使用的知识。中文检索、写作与引用构成每天的工作。\n\n";
  return (
    `# 笔记 ${folder}/${file}\n\n唯一定位：资料库第 ${folder} 组第 ${file} 篇。\n\n` +
    paragraph.repeat(69)
  );
}

/** 固定视觉验收矩阵，同时覆盖正文、密集信息和最小支持窗口。 */
export const visualViewports = [
  { width: 1440, height: 900 },
  { width: 1100, height: 720 },
  { width: 640, height: 480 },
] as const;
