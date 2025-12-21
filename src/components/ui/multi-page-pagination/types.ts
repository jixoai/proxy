/**
 * 多页分页组件类型定义
 *
 * URL 格式：
 * - `pages=-1,2` 动态模式：始终锚定最后一页，显示2页
 * - `pages=4,2` 静态模式：锚定第4页，显示2页
 */

/** 分页模式 */
export type PaginationMode = "dynamic" | "static";

/** 分页状态 */
export interface MultiPageState {
  /** 锚定页码，-1 表示动态锚定最后一页 */
  anchor: number;
  /** 显示页数 */
  count: number;
  /** 是否锚定（pin） */
  pinned: boolean;
}

/** 解析后的页码范围 */
export interface PageRange {
  /** 起始页（包含），从 1 开始 */
  start: number;
  /** 结束页（包含） */
  end: number;
  /** 实际显示的页码列表（降序，最新的在前） */
  pages: number[];
}

/** URL 参数格式 */
export interface PaginationUrlParams {
  /** anchor,count 格式，如 "-1,2" 或 "4,2" */
  pages?: string;
}

/**
 * 解析 URL 参数为分页状态
 */
export function parsePaginationParams(pagesParam: string | null): MultiPageState {
  if (!pagesParam) {
    // 默认：动态锚定最后一页，显示 2 页
    return { anchor: -1, count: 2, pinned: false };
  }

  const parts = pagesParam.split(",");
  const anchor = parseInt(parts[0] ?? "", 10);
  const count = parseInt(parts[1] ?? "", 10) || 2;

  if (isNaN(anchor)) {
    return { anchor: -1, count: 2, pinned: false };
  }

  return {
    anchor,
    count: Math.max(1, Math.min(count, 5)), // 限制 1-5 页
    pinned: anchor > 0, // 正数表示静态锚定
  };
}

/**
 * 序列化分页状态为 URL 参数
 */
export function serializePaginationParams(state: MultiPageState): string {
  return `${state.anchor},${state.count}`;
}

/**
 * 根据分页状态和总页数计算实际显示的页码范围
 */
export function calculatePageRange(state: MultiPageState, totalPages: number): PageRange {
  if (totalPages <= 0) {
    return { start: 1, end: 1, pages: [1] };
  }

  // 计算实际的锚定页
  const actualAnchor = state.anchor < 0 ? totalPages : Math.min(state.anchor, totalPages);

  // 计算起始页（锚定页往前推 count-1 页）
  const start = Math.max(1, actualAnchor - state.count + 1);
  const end = Math.min(actualAnchor, totalPages);

  // 生成页码列表（降序）
  const pages: number[] = [];
  for (let i = end; i >= start; i--) {
    pages.push(i);
  }

  return { start, end, pages };
}
