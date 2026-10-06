import type { LinkRecord, LinkResolution } from "../../shared/api";

/** 同一目标的引用合成一组；非空原始记录保留每处标题、语法和字节位置，供逐条跳转。 */
export type OutlinkGroup = {
  key: string;
  target: string;
  resolution: LinkResolution;
  items: [LinkRecord, ...LinkRecord[]];
};

/** 指向当前文件的跳转单独展示，不计入指向其他文件的目标数量。 */
export type OutlinkGroups = {
  resolved: OutlinkGroup[];
  ambiguous: OutlinkGroup[];
  dead: OutlinkGroup[];
  self: OutlinkGroup[];
};

/**
 * 按解析状态和目标分组；已解析目标用实际路径合并别名及标题引用。
 * 显式路径与纯锚点指向当前文件时都归入内部跳转，原始解析结果保持不变。
 * @param links 当前文档的索引出链，保持原文出现顺序。
 * @returns 各组按首次出现排列；未解析目标按状态、语法和原文区分，不猜测文件身份。
 */
export function presentOutlinks(links: readonly LinkRecord[]): OutlinkGroups {
  const groups: OutlinkGroups = { resolved: [], ambiguous: [], dead: [], self: [] };
  const byTarget = new Map<string, OutlinkGroup>();
  for (const link of links) {
    const resolution =
      link.resolution === "resolved" && link.toPath === link.fromPath ? "self" : link.resolution;
    const key =
      resolution === "resolved" && link.toPath !== null
        ? JSON.stringify([resolution, link.toPath])
        : JSON.stringify([resolution, link.kind, link.toRaw]);
    const existing = byTarget.get(key);
    if (existing) existing.items.push(link);
    else {
      const group: OutlinkGroup = {
        key,
        target: resolution === "self" ? link.toRaw : (link.toPath ?? link.toRaw),
        resolution,
        items: [link],
      };
      byTarget.set(key, group);
      groups[resolution].push(group);
    }
  }
  return groups;
}
