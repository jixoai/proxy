import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  calculatePageRange,
  parsePaginationParams,
  serializePaginationParams,
  type MultiPageState,
  type PageRange,
} from "./types";

export interface UseMultiPagePaginationOptions {
  /** 总页数 */
  totalPages: number;
  /** 当前 URL 参数值 */
  pagesParam: string | undefined;
  /** 更新 URL 参数的回调 */
  onPagesChange: (value: string) => void;
}

export interface UseMultiPagePaginationReturn {
  /** 当前分页状态 */
  state: MultiPageState;
  /** 计算后的页码范围 */
  pageRange: PageRange;
  /** 总页数 */
  totalPages: number;
  /** 切换 pin 状态 */
  togglePin: () => void;
  /** 设置锚定页 */
  setAnchor: (anchor: number) => void;
  /** 设置显示页数 */
  setCount: (count: number) => void;
  /** 导航到上一组页码 */
  goToPrevGroup: () => void;
  /** 导航到下一组页码 */
  goToNextGroup: () => void;
  /** 是否可以向前翻页 */
  canGoPrev: boolean;
  /** 是否可以向后翻页 */
  canGoNext: boolean;
}

export function useMultiPagePagination({
  totalPages,
  pagesParam,
  onPagesChange,
}: UseMultiPagePaginationOptions): UseMultiPagePaginationReturn {
  const prevTotalPagesRef = useRef(totalPages);

  // 解析当前状态
  const state = useMemo(() => {
    return parsePaginationParams(pagesParam ?? null);
  }, [pagesParam]);

  // 计算页码范围
  const pageRange = useMemo(() => calculatePageRange(state, totalPages), [state, totalPages]);

  // 更新状态
  const updateState = useCallback(
    (newState: MultiPageState) => {
      onPagesChange(serializePaginationParams(newState));
    },
    [onPagesChange],
  );

  // 当总页数增加且处于动态模式时，自动跟随最后一页
  useEffect(() => {
    if (!state.pinned && totalPages > prevTotalPagesRef.current) {
      // 动态模式下，新页面进来自动滚动到最后
      // 不需要更新 URL，因为 anchor=-1 会自动计算到最后一页
    }
    prevTotalPagesRef.current = totalPages;
  }, [totalPages, state.pinned]);

  // 切换 pin 状态
  const togglePin = useCallback(() => {
    if (state.pinned) {
      // 从静态切换到动态
      updateState({ ...state, anchor: -1, pinned: false });
    } else {
      // 从动态切换到静态，锚定当前实际页码
      const actualAnchor = state.anchor < 0 ? totalPages : state.anchor;
      updateState({ ...state, anchor: actualAnchor, pinned: true });
    }
  }, [state, totalPages, updateState]);

  // 设置锚定页
  const setAnchor = useCallback(
    (anchor: number) => {
      updateState({
        ...state,
        anchor,
        pinned: anchor > 0,
      });
    },
    [state, updateState],
  );

  // 设置显示页数
  const setCount = useCallback(
    (count: number) => {
      updateState({
        ...state,
        count: Math.max(1, Math.min(count, 5)),
      });
    },
    [state, updateState],
  );

  // 导航到上一组页码（向更早的页面）
  const goToPrevGroup = useCallback(() => {
    const newAnchor = Math.max(state.count, pageRange.start - 1);
    updateState({
      ...state,
      anchor: newAnchor,
      pinned: true, // 手动导航时自动 pin
    });
  }, [state, pageRange, updateState]);

  // 导航到下一组页码（向更新的页面）
  const goToNextGroup = useCallback(() => {
    if (pageRange.end >= totalPages) {
      // 已经在最后，切换到动态模式
      updateState({ ...state, anchor: -1, pinned: false });
    } else {
      const newAnchor = Math.min(totalPages, pageRange.end + state.count);
      updateState({
        ...state,
        anchor: newAnchor,
        pinned: true,
      });
    }
  }, [state, pageRange, totalPages, updateState]);

  const canGoPrev = pageRange.start > 1;
  const canGoNext = pageRange.end < totalPages || state.pinned;

  return {
    state,
    pageRange,
    totalPages,
    togglePin,
    setAnchor,
    setCount,
    goToPrevGroup,
    goToNextGroup,
    canGoPrev,
    canGoNext,
  };
}
