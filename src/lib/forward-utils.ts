export interface ForwardLike {
  name: string;
  path?: string | null;
}

export function normalizePathname(pathname: string | null | undefined): string {
  if (!pathname || pathname.trim() === "") return "/";
  return pathname.startsWith("/") ? pathname : `/${pathname}`;
}

function sortGroupBySpecificity<T extends ForwardLike>(group: T[]): T[] {
  return [...group].sort((a, b) => {
    const aPath = a.path ?? "";
    const bPath = b.path ?? "";

    const aHasPath = aPath.length > 0;
    const bHasPath = bPath.length > 0;
    if (aHasPath && !bHasPath) return -1;
    if (!aHasPath && bHasPath) return 1;

    if (aHasPath && bHasPath && aPath.length !== bPath.length) {
      return bPath.length - aPath.length;
    }

    return 0;
  });
}

/**
 * 将同名的转发规则强制聚合在一起。
 * 组的顺序保持首次出现的顺序不变，组内顺序保持原始顺序不变。
 * 
 * @param sortWithinGroup 是否在组内按路径长度排序（长路径优先）。默认 false，保持原始顺序。
 */
export function normalizeForwardGroups<T extends ForwardLike>(forwards: T[], sortWithinGroup = false): T[] {
  const groups = new Map<string, { items: T[]; firstIndex: number }>();
  const order: string[] = [];

  forwards.forEach((forward, index) => {
    const existing = groups.get(forward.name);
    if (existing) {
      existing.items.push(forward);
    } else {
      groups.set(forward.name, { items: [forward], firstIndex: index });
      order.push(forward.name);
    }
  });

  const grouped = order.flatMap((name) => {
    const entry = groups.get(name);
    if (!entry) return [];
    return sortWithinGroup ? sortGroupBySpecificity(entry.items) : entry.items;
  });

  return grouped;
}
