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
 * 将同名的转发规则强制聚合在一起，并在组内按路由前缀长度排序（长路径优先，其次无路径兜底）。
 * 组的顺序保持首次出现的顺序不变。
 */
export function normalizeForwardGroups<T extends ForwardLike>(forwards: T[]): T[] {
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
    return entry ? sortGroupBySpecificity(entry.items) : [];
  });

  return grouped;
}
