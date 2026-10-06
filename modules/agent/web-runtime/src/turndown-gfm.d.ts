/** GFM 插件没有上游声明，按其实际插件函数契约补齐类型。 */
declare module "turndown-plugin-gfm" {
  import type TurndownService from "turndown";
  export const gfm: TurndownService.Plugin;
}
