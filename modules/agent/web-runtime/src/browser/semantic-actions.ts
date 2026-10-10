import type { ElementHandle, Frame, Locator } from "playwright-core";
import { elementAction, type BrowserExecution, type ElementAction } from "./actions.js";
import { describeElement } from "./dom.js";
import { inspectSemanticDom } from "./semantic-dom.js";
import { semanticSelector, type SemanticAction, type SemanticLocator } from "./semantic.js";
import type { BrowserPage } from "./observation.js";

async function locator(
  entry: BrowserPage,
  spec: SemanticLocator,
  execution: BrowserExecution,
): Promise<Locator> {
  let frame: Frame = entry.page.mainFrame();
  if (spec.frame_url !== undefined) {
    const matches = entry.page.frames().filter((candidate) => candidate.url() === spec.frame_url);
    if (matches.length !== 1 || !matches[0]) throw new Error("frame URL 需要唯一的当前框架");
    frame = matches[0];
  }
  for (const chain of spec.frames ?? []) {
    execution.check();
    const match = frame.locator(semanticSelector(chain));
    if (
      (await entry.guard(() => match.count(), {
        signal: execution.signal,
        timeout: execution.budget(),
      })) !== 1
    )
      throw new Error("iframe 路径需要唯一目标");
    const handle = await entry.guard(() => match.elementHandle({ timeout: execution.budget() }), {
      signal: execution.signal,
      timeout: execution.budget(),
      release: async (handle) => {
        await handle?.dispose();
      },
    });
    if (!handle) throw new Error("iframe 目标已经失效");
    try {
      if (
        !(await entry.guard(
          () => handle.evaluate((element) => element instanceof HTMLIFrameElement),
          { signal: execution.signal, timeout: execution.budget() },
        ))
      )
        throw new Error("frame 路径目标不是 iframe");
      const nested = await entry.guard(() => handle.contentFrame(), {
        signal: execution.signal,
        timeout: execution.budget(),
      });
      if (!nested) throw new Error("iframe 尚未加载或已经失效");
      frame = nested;
    } finally {
      await handle.dispose();
    }
  }
  execution.check();
  return frame.locator(semanticSelector(spec.chain));
}

/** 定位器只执行一次当前查询；保存真实对象后等待和派发始终校验同一指纹。 */
export async function interactSemantic(
  entry: BrowserPage,
  action: SemanticAction,
  execution: BrowserExecution,
): Promise<Record<string, unknown> | undefined> {
  const match = await locator(entry, action.locator, execution);
  const count = await entry.guard(() => match.count(), {
    signal: execution.signal,
    timeout: execution.budget(),
  });
  execution.check();
  if (action.operation === "count") return { count };
  if (count !== 1) throw new Error(`语义目标需要唯一匹配，实际为 ${count}`);
  const element: ElementHandle | null = await entry.guard(
    () => match.elementHandle({ timeout: execution.budget() }),
    {
      signal: execution.signal,
      timeout: execution.budget(),
      release: async (handle) => {
        await handle?.dispose();
      },
    },
  );
  if (!element) throw new Error("语义目标已经失效");
  try {
    const original = await entry.guard(() => element.evaluate(describeElement), {
      signal: execution.signal,
      timeout: execution.budget(),
    });
    const verify = async (): Promise<void> => {
      execution.check();
      const current = await entry.guard(() => element.evaluate(describeElement), {
        signal: execution.signal,
        timeout: execution.budget(),
      });
      if (!current.connected || current.fingerprint !== original.fingerprint)
        throw new Error("语义目标身份或业务上下文已变化");
    };
    if (action.operation === "inspect") {
      await verify();
      return await entry.guard(() => element.evaluate(inspectSemanticDom), {
        signal: execution.signal,
        timeout: execution.budget(),
      });
    }
    await elementAction(entry, element, elementOperation(action), execution, verify);
    return undefined;
  } finally {
    await element.dispose();
  }
}

function elementOperation(action: SemanticAction): ElementAction {
  const ref = "target";
  switch (action.operation) {
    case "click":
    case "hover":
      return { action: action.operation, ref };
    case "fill":
      return { action: "fill", ref, text: action.text };
    case "select":
      return { action: "select", ref, values: action.values, by: action.by };
    case "check":
      return { action: "check", ref, checked: action.checked };
    case "press":
      return { action: "press", ref, key: action.key };
    default:
      throw new Error("只读语义操作不能派发输入");
  }
}
