import type { ElementHandle, Locator } from "playwright-core";
import type { BrowserAction, BrowserResult, BrowserStep } from "./contract.js";
import type { BrowserFiles } from "./files.js";
import type { BrowserPage } from "./observation.js";

/** 动作执行前共享取消与预算检查；dispatch 同时标记此后失败可能存在副作用。 */
export type BrowserExecution = {
  signal: AbortSignal;
  check(): void;
  budget(): number;
  dispatch(): void;
  /** 只读取本次操作新增的有界网络诊断，必须在观察编码前采样。 */
  warnings(): string[];
};

/** 控件执行阶段已经完成引用消歧；按键动作也必须绑定具体控件。 */
export type ElementAction = BrowserStep | { action: "hover"; ref: string } | { action: "press"; ref: string; key: string };

/**
 * 读取各框架当前可见文字并分页，任何框架缺失均明确失败，不能伪装为完整读取。
 * @param entry 当前会话内的页面。
 * @param offset 按 Unicode 字符计数的起始位置。
 * @param maximum 当前页允许返回的最大字符数。
 * @param execution 本次调用的取消与时间预算。
 * @returns 正文页及下一页位置；读到末尾时 next_offset 为 null。
 * @throws 偏移越界、页面读取失败、弹窗、中断或超时。
 */
export async function readText(
  entry: BrowserPage,
  offset: number,
  maximum: number,
  execution: BrowserExecution,
): Promise<BrowserResult["text_page"]> {
  const sections: string[] = [];
  for (const frame of entry.page.frames()) {
    execution.check();
    sections.push(
      `[${frame.url()}]\n${await entry.guard(() => frame.locator("body").innerText({ timeout: execution.budget() }))}`,
    );
  }
  const characters = [...sections.join("\n\n")];
  if (offset > characters.length) throw new Error("正文偏移超过当前页面长度，请从零重新读取");
  const end = Math.min(characters.length, offset + maximum);
  return {
    text: characters.slice(offset, end).join(""),
    offset,
    next_offset: end < characters.length ? end : null,
    total_chars: characters.length,
  };
}

/**
 * 文字查找覆盖子框架，多个匹配明确要求消歧，不隐式选择第一个。
 * @param entry 当前会话内的页面。
 * @param text 需要定位的文字。
 * @param exact 是否采用精确匹配。
 * @returns 只含一个匹配的定位器；本函数不滚动或派发输入。
 * @throws 匹配数量不是一、页面读取失败或弹窗中断。
 */
export async function findText(entry: BrowserPage, text: string, exact: boolean): Promise<Locator> {
  const matches: Locator[] = [];
  for (const frame of entry.page.frames()) {
    const locator = frame.getByText(text, { exact });
    const count = await entry.guard(() => locator.count());
    if (count > 1) throw new Error("查找目标不唯一，请提供更完整的文字");
    if (count === 1) matches.push(locator);
  }
  if (matches.length !== 1 || !matches[0])
    throw new Error("查找需要唯一目标，请根据页面观察提供更完整的文字");
  return matches[0];
}

/**
 * 等待任一框架出现可见文字，或所有框架中的匹配均隐藏；每轮重新读取框架集合并检查取消。
 * @param entry 当前会话内的页面。
 * @param text 需要等待的文字。
 * @param state visible 等待至少一处可见，hidden 等待所有匹配不可见。
 * @param exact 是否采用精确匹配。
 * @param execution 本次调用的取消与时间预算。
 * @returns 目标状态满足后完成，不派发输入。
 * @throws 页面读取失败、弹窗、中断或超时；移除的框架不再算作可见匹配。
 */
export async function waitForText(
  entry: BrowserPage,
  text: string,
  state: "visible" | "hidden",
  exact: boolean,
  execution: BrowserExecution,
): Promise<void> {
  for (;;) {
    execution.check();
    let visible = false;
    for (const frame of entry.page.frames()) {
      execution.check();
      if (frame.isDetached()) continue;
      try {
        for (const match of await entry.guard(() => frame.getByText(text, { exact }).all())) {
          if (await entry.guard(() => match.isVisible())) {
            visible = true;
            break;
          }
        }
      } catch (error) {
        // 框架在读取期间被移除意味着该框架不再显示文字；其余错误不能被当成隐藏。
        if (!frame.isDetached()) throw error;
      }
      if (visible) break;
    }
    if (visible === (state === "visible")) return;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(50, execution.budget())));
  }
}

/**
 * 对当前观察中的控件或截图执行输入；等待完成后重验身份，再标记真实输入的派发阶段。
 * @param entry 当前会话内的页面。
 * @param action 已校验并绑定观察的输入动作。
 * @param files 当前会话的文件边界，上传内容必须先固定为已授权字节。
 * @param execution 本次调用的取消、预算及派发回调。
 * @returns 目标原语完成后返回；任务是否成功仍须检查网页证据。
 * @throws 引用失效、文件越界、浏览器失败、弹窗、中断或超时；派发后失败必须结算为 unknown。
 */
export async function interact(
  entry: BrowserPage,
  action: Exclude<Extract<BrowserAction, { observation: string }>, { action: "batch" }>,
  files: BrowserFiles,
  execution: BrowserExecution,
): Promise<void> {
  entry.requireObservation(action.observation);
  if (action.action === "type") {
    if (action.ref !== undefined) {
      const element = await entry.element(action.observation, action.ref);
      execution.dispatch();
      await entry.guard(() => element.focus(), {
        signal: execution.signal,
        timeout: execution.budget(),
      });
      if (
        !(await entry.guard(() =>
          element.evaluate((node) => node instanceof Element && node.matches(":focus-within")),
        ))
      )
        throw new Error("目标控件未获得输入焦点，未发送文字");
    }
    for (const character of action.text) {
      execution.dispatch();
      await entry.guard(() => entry.page.keyboard.type(character), {
        signal: execution.signal,
        timeout: execution.budget(),
      });
    }
    return;
  }
  if (action.action === "pointer" || action.action === "drag")
    return pointer(entry, action, execution);
  if (action.action === "scroll") {
    execution.dispatch();
    await entry.guard(() => entry.page.mouse.wheel(action.x, action.y), {
      signal: execution.signal,
      timeout: execution.budget(),
    });
    return;
  }
  if (action.action === "press" && action.ref === undefined) {
    execution.dispatch();
    await entry.guard(() => entry.page.keyboard.press(action.key), {
      signal: execution.signal,
      timeout: execution.budget(),
    });
    return;
  }
  if (action.ref === undefined) throw new Error("此动作缺少控件引用");
  const element = await entry.element(action.observation, action.ref);
  if (action.action === "upload") {
    const payload = await files.upload(action.paths);
    // 文件读取包含异步等待，派发前再次确认网页没有复用或替换上传控件。
    await entry.element(action.observation, action.ref);
    execution.dispatch();
    await entry.guard(
      (signal) => element.setInputFiles(payload, { timeout: execution.budget(), signal }),
      { signal: execution.signal, timeout: execution.budget() },
    );
    return;
  }
  const ref = action.ref;
  await elementAction(entry, element, { ...action, ref }, execution, async () => { await entry.element(action.observation, ref); });
}

async function pointer(
  entry: BrowserPage,
  action: Extract<BrowserAction, { action: "pointer" | "drag" }>,
  execution: BrowserExecution,
): Promise<void> {
  await entry.verifyLayout(action.observation);
  const viewport = entry.requireObservation(action.observation).viewport;
  const points =
    action.action === "pointer"
      ? [[action.x, action.y]]
      : [
          [action.from_x, action.from_y],
          [action.to_x, action.to_y],
        ];
  for (const [x, y] of points)
    if (x === undefined || y === undefined || x >= viewport.width || y >= viewport.height)
      throw new Error("坐标超出当前截图视口");
  const mouse = entry.page.mouse;
  const options = { signal: execution.signal, timeout: execution.budget() };
  const button = action.action === "pointer" ? action.button : "left";
  let pressed = false;
  execution.dispatch();
  try {
    await entry.guard(
      () =>
        mouse.move(
          action.action === "pointer" ? action.x : action.from_x,
          action.action === "pointer" ? action.y : action.from_y,
        ),
      options,
    );
    if (action.action === "pointer") {
      for (let clickCount = 1; clickCount <= action.clicks; clickCount++) {
        execution.check();
        entry.requireObservation(action.observation);
        await entry.guard(() => {
          pressed = true;
          return mouse.down({ button, clickCount });
        }, options);
        await entry.guard(
          () => {
            pressed = false;
            return mouse.up({ button, clickCount });
          },
          { timeout: 1000, cleanup: true },
        );
      }
    } else {
      await entry.guard(() => {
        pressed = true;
        return mouse.down();
      }, options);
      for (let step = 1; step <= 12; step++) {
        execution.check();
        await entry.guard(
          () =>
            mouse.move(
              action.from_x + ((action.to_x - action.from_x) * step) / 12,
              action.from_y + ((action.to_y - action.from_y) * step) / 12,
            ),
          options,
        );
      }
    }
  } finally {
    if (pressed) await entry.guard(() => mouse.up({ button }), { timeout: 1000, cleanup: true });
  }
}

/** 对已经固定的真实对象执行动作；verify 在自动等待后再次核验原始身份，失败不派发。 */
export async function elementAction(
  entry: BrowserPage,
  element: ElementHandle,
  action: ElementAction,
  execution: BrowserExecution,
  verify: () => Promise<void>,
): Promise<void> {
  await prepareElement(entry, element, action, execution);
  // 自动等待期间节点可以被虚拟列表复用；派发真实输入前必须重验语义身份。
  await verify();
  execution.dispatch();
  await entry.guard(
    async (signal) => {
      const options = { timeout: Math.min(1000, execution.budget()), signal };
      switch (action.action) {
        case "click":
          await element.click(options);
          break;
        case "hover":
          await element.hover(options);
          break;
        case "fill":
          await element.fill(action.text, options);
          break;
        case "select":
          await element.selectOption(
            action.values.map((value) => (action.by === "value" ? { value } : { label: value })),
            options,
          );
          break;
        case "check":
          await element.setChecked(action.checked, options);
          break;
        case "press":
          await element.press(action.key, options);
          break;
      }
    },
    { signal: execution.signal, timeout: execution.budget() },
  );
}

async function prepareElement(
  entry: BrowserPage,
  element: ElementHandle,
  action: ElementAction,
  execution: BrowserExecution,
): Promise<void> {
  await entry.guard(
    async (signal) => {
      const options = { trial: true, timeout: execution.budget(), signal };
      switch (action.action) {
        case "click":
          await element.click(options);
          break;
        case "hover":
          await element.hover(options);
          break;
        case "check":
          await element.setChecked(action.checked, options);
          break;
        case "fill":
          await element.waitForElementState("editable", options);
          break;
        case "select":
          await element.waitForElementState("visible", options);
          await element.waitForElementState("enabled", options);
          break;
      }
    },
    { signal: execution.signal, timeout: execution.budget() },
  );
}
