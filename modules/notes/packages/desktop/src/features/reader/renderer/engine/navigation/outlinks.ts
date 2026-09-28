/**
 * 出链呈现：按索引里已经记下的解析状态分组。
 *
 * 点击仍走实时解析（歧义弹候选、死链可以创建），分组本身不再把死链和歧义写成同一句。
 */

import type { LinkRecord } from "../../../shared/api";

/** 分组后的出链，各组保持文档顺序。 */
export type OutlinkGroups = {
  /** 已唯一解析到库内文件。 */
  resolved: LinkRecord[];
  /** 同名多候选。 */
  ambiguous: LinkRecord[];
  /** 没有任何候选。 */
  dead: LinkRecord[];
  /** 纯锚点，指向当前笔记。 */
  self: LinkRecord[];
};

/**
 * 按解析状态分组出链。
 *
 * @param links `indexLinksFrom` 返回的出链。
 * @returns 四组出链；未知状态不会出现，协议层已拒绝。
 */
export function presentOutlinks(links: readonly LinkRecord[]): OutlinkGroups {
  const groups: OutlinkGroups = { resolved: [], ambiguous: [], dead: [], self: [] };
  for (const link of links) groups[link.resolution].push(link);
  return groups;
}
