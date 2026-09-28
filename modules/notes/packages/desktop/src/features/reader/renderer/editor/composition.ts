/**
 * 输入法拥有的按键不得触发应用命令；部分系统在最后一个按键前已发出 compositionend，
 * 此时 isComposing 为 false，但仍以 229 标识输入法按键。此判断不阻止原生候选操作。
 */
export function isCompositionKey(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229;
}

/** 一个输入表面的临时组词状态，不持有正文或保存状态。 */
export type CompositionGuard = {
  /** 组词或其按键默认动作尚未结束时，拒绝提交、跳转和关闭。 */
  readonly active: boolean;
  /** 绑定表面事件；同一实例只绑定一个元素，卸载时调用 destroy 释放监听。 */
  bind: (element: HTMLElement) => { destroy: () => void };
};

/**
 * 为表单或源码输入框保护组词生命周期；键盘默认提交、dialog cancel 没有 isComposing，
 * 因此保留输入法按键归属直到松键或下一次独立操作，不依赖固定时间延迟。
 * @returns active 用于动作入口，bind 可直接作为 Svelte action；不会吞掉原生输入事件。
 */
export function createCompositionGuard(): CompositionGuard {
  let composing = false;
  let compositionKey = false;
  return {
    get active() {
      return composing || compositionKey;
    },
    bind(element) {
      const controller = new AbortController();
      const options = { capture: true, signal: controller.signal };
      const releaseKey = () => {
        compositionKey = false;
      };
      element.addEventListener(
        "compositionstart",
        () => {
          composing = true;
        },
        options,
      );
      element.addEventListener(
        "compositionend",
        () => {
          composing = false;
        },
        options,
      );
      element.addEventListener(
        "keydown",
        (event) => {
          compositionKey = composing || isCompositionKey(event);
        },
        options,
      );
      element.addEventListener("keyup", releaseKey, options);
      element.addEventListener("pointerdown", releaseKey, options);
      element.addEventListener("focusout", releaseKey, options);
      return {
        destroy() {
          controller.abort();
          composing = false;
          compositionKey = false;
        },
      };
    },
  };
}
