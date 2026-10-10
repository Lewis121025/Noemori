import { expect, it } from "vitest";
import { pairToolResults, toolAction, toolOutput, toolValueText } from "../../../../modules/notes/packages/desktop/src/features/agent/shared/tool-presentation";

it("终端非零退出码与截断信息可见，正文和原始元数据各自保留", () => {
  const output = { status: "exited", exit_code: 1, output: "  检查未通过\n", truncated: true, omitted_chars: 120 };
  const view = toolOutput({ call_id: "one", name: "terminal", output, is_error: false });
  expect(view.text).toBe("  检查未通过\n");
  expect(view.state).toBe("退出码 1");
  expect(view.tone).toBe("error");
  expect(view.note).toBe("输出已截断，省略 120 字符");
  expect(view.extracted).toBe(true);
});

it("已返回的终端观察仍在后台运行时，不宣称进程已经完成", () => {
  expect(toolOutput({ call_id: "one", name: "terminal", output: { status: "running", output: "启动中\n" }, is_error: false }).state).toBe("后台运行");
});

it("UI 脚本失败仍显示已提交输出，未知动作结果不能显示为成功", () => {
  const view = toolOutput({ call_id: "ui", name: "ui_repl", is_error: false,
    output: { prints: ["已读取标题", { count: 2 }], error: "后续操作中断", operations: [{ outcome: "unknown" }] },
  });
  expect(view.text).toBe('已读取标题\n{\n  "count": 2\n}');
  expect(view.error).toBe("后续操作中断");
  expect(view.state).toBe("结果待核实");
  expect(view.tone).toBe("warning");
});

it("脚本正常返回但应用动作未执行时，执行记录不能显示为完成", () => {
  const output = (outcomes: string[]) => toolOutput({ call_id: "ui", name: "ui_repl", is_error: false,
    output: { prints: ["已保留资料"], operations: outcomes.map((outcome) => ({ outcome })) },
  });
  expect(output(["not_executed"]).state).toBe("未执行");
  expect(output(["executed", "not_executed"]).state).toBe("部分操作未执行");
  expect(output(["not_executed"]).tone).toBe("warning");
});

it("应用脚本错误先显示原因，堆栈保留在原始结果中，已提交文本不丢失", () => {
  const error = "Error: 页面暂时未响应\n    at <eval> (eval_script:1:43)\n";
  const output = { prints: ["已保留整理内容"], error };
  const view = toolOutput({ call_id: "ui", name: "ui_repl", is_error: true, output });
  expect(view.error).toBe("页面暂时未响应");
  expect(view.text).toBe("已保留整理内容");
  expect(view.tone).toBe("error");
  expect(JSON.parse(toolValueText(output)).error).toBe(error);
});

it("浏览器分页只突出实际页面正文，同时提示还有后续内容", () => {
  const view = toolOutput({ call_id: "web", name: "browser", is_error: false,
    output: { outcome: "executed", text_page: { text: "页面正文", next_offset: 200 } },
  });
  expect(view.text).toBe("页面正文");
  expect(view.note).toBe("还有后续内容");
});

it("未知工具保留结构，JSON 外观的字符串不会被猜测或改写", () => {
  const value = '{"output":"原始字符串"}';
  expect(toolOutput({ call_id: "custom", name: "custom", output: value, is_error: false }).text).toBe(value);
  const object = { output: "自定义字段", status: "running" };
  const view = toolOutput({ call_id: "custom", name: "custom", output: object, is_error: false });
  expect(view.text).toBe(JSON.stringify(object, null, 2));
  expect(view.extracted).toBe(false);
  expect(view.state).toBe("已完成");
});

it("浏览器部分读取失败的说明与截断提示都可见", () => {
  const view = toolOutput({ call_id: "web", name: "browser", is_error: false,
    output: { outcome: "executed", observation: { text: "已读取的正文", truncated: true, warnings: ["嵌入页面未能读取"] } },
  });
  expect(view.text).toBe("已读取的正文");
  expect(view.note).toBe("页面内容已截断\n嵌入页面未能读取");
});

it("结果只能与同标识且同工具名称的调用合并，孤立结果留给独立展示", () => {
  const matched = { call_id: "one", name: "terminal", output: "结果", is_error: false };
  const pairs = pairToolResults([
    { role: "assistant", content: [{ type: "tool_call", value: { id: "one", name: "terminal", arguments: {} } }] },
    { role: "tool", content: [
      { type: "tool_result", value: matched },
      { type: "tool_result", value: { ...matched, call_id: "missing" } },
      { type: "tool_result", value: { ...matched, name: "browser" } },
    ] },
  ]);
  expect([...pairs.keys()]).toEqual(["one"]);
  expect(pairs.get("one")).toBe(matched);
});

it("执行条目显示实际动作和对象，完整命令仍保留", () => {
  const action = (cmd: string) => toolAction({ id: "one", name: "terminal", arguments: { action: "exec", cmd } });
  expect(action('cat "资料摘要.md"')).toMatchObject({ kind: "file", label: "读取文件", target: "资料摘要.md", source: 'cat "资料摘要.md"' });
  expect(action("sed -n '1,120p' README.md")).toMatchObject({ kind: "file", label: "读取文件", target: "README.md" });
  expect(action('rg -n "关键词" notes')).toMatchObject({ kind: "search", label: "搜索内容", target: "关键词 · notes" });
  expect(action("ls -la notes")).toMatchObject({ kind: "folder", label: "列出目录", target: "notes" });
  expect(action("pnpm check")).toMatchObject({ kind: "command", label: "运行命令", target: "pnpm check" });
  for (const cmd of ['cat README.md; rm file', 'cat "$path"', 'cat $(get_path)', 'cat README.md\nprintf done'])
    expect(action(cmd)).toMatchObject({ kind: "command", label: "运行命令", source: cmd });
});

it("浏览器和应用条目采用实际参数与回执，未知脚本不猜测动作", () => {
  expect(toolAction({ id: "web", name: "browser", arguments: { action: "navigate", url: "https://example.com/guide" } }))
    .toMatchObject({ kind: "browser", label: "打开网页", target: "https://example.com/guide" });
  const call = { id: "ui", name: "ui_repl", arguments: { type: "run", code: 'print("browser.open is documentation");' } };
  expect(toolAction(call)).toMatchObject({ kind: "script", label: "运行脚本", source: call.arguments.code });
  expect(toolAction(call, { call_id: "ui", name: "ui_repl", is_error: false, output: { operations: [
    { request: { domain: "browser", action: { action: "read", page: "page-one" } }, outcome: "executed" },
  ] } })).toMatchObject({ kind: "browser", label: "读取网页", target: "page-one" });
  expect(toolAction(call, { call_id: "ui", name: "ui_repl", is_error: false, output: { operations: [
    { request: { domain: "computer", action: { action: "observe", app: "notes", window: "one" } }, outcome: "executed" },
  ] } })).toMatchObject({ kind: "app", label: "查看窗口内容", target: "one" });
  expect(toolAction({ id: "custom", name: "custom", arguments: {} })).toMatchObject({ kind: "tool", label: "custom" });
});
