/**
 * 补全弹层的键盘拦截插件。
 *
 * 弹层激活期间接管导航键，其余按键照常进入编辑器；输入法组词期间的
 * 按键（`isComposing`）不拦截，候选框的上下键属于输入法。
 */

import { Plugin, PluginKey } from "prosemirror-state";

/** 弹层键盘动作；由编辑器组件持有状态并实现。 */
export type SuggestKeymap = {
  /** 弹层是否激活且有候选可导航。 */
  active: () => boolean;
  /** 上下移动选中项，循环。 */
  move: (delta: number) => void;
  /** 提交当前选中候选。 */
  choose: () => void;
  /** 关闭弹层，不改动文档。 */
  cancel: () => void;
};

const linkSuggestKey = new PluginKey("link-suggest");

/** 创建绑定到给定动作的拦截插件；每个编辑器实例一份。 */
export function linkSuggestPlugin(keys: SuggestKeymap): Plugin {
  return new Plugin({
    key: linkSuggestKey,
    props: {
      handleKeyDown(_view, event) {
        if (event.isComposing || !keys.active()) return false;
        switch (event.key) {
          case "ArrowDown":
            keys.move(1);
            return true;
          case "ArrowUp":
            keys.move(-1);
            return true;
          case "Enter":
          case "Tab":
            keys.choose();
            return true;
          case "Escape":
            keys.cancel();
            return true;
          default:
            return false;
        }
      },
    },
  });
}
