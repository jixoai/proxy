import { ChevronLeftIcon, ChevronRightIcon, PinIcon, PinOffIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { UseMultiPagePaginationReturn } from "./useMultiPagePagination";

export interface MultiPagePaginationProps {
  /** 从 useMultiPagePagination 获取的状态和方法 */
  pagination: UseMultiPagePaginationReturn;
  /** 自定义 className */
  className?: string;
}

/**
 * 多页分页组件
 *
 * 显示格式示例：
 * - `< [4,3], 2, 1 >` 当前显示第4和第3页
 * - 支持 pin/unpin 切换动态/静态锚定模式
 */
export function MultiPagePagination({ pagination, className }: MultiPagePaginationProps) {
  const {
    state,
    pageRange,
    totalPages,
    togglePin,
    goToPrevGroup,
    goToNextGroup,
    canGoPrev,
    canGoNext,
  } = pagination;

  if (totalPages <= 1) {
    return null;
  }

  // 构建页码显示
  // 当前显示的页码用 [x,y] 包裹，其他页码显示为普通数字
  const renderPageIndicator = () => {
    const allPages: number[] = [];
    for (let i = totalPages; i >= 1; i--) {
      allPages.push(i);
    }

    const activePages = new Set(pageRange.pages);

    return (
      <div className="flex items-center gap-1 text-sm">
        {/* 渲染所有页码，活跃的用 [] 包裹 */}
        {allPages.map((page, idx) => {
          const isActive = activePages.has(page);
          const isFirstActive = page === pageRange.end;
          const isLastActive = page === pageRange.start;

          // 限制显示的页码数量，避免太长
          const maxDisplay = 7;
          const showEllipsisBefore = idx === 1 && allPages.length > maxDisplay && page < totalPages - 1;
          const showEllipsisAfter = idx === allPages.length - 2 && allPages.length > maxDisplay && page > 2;

          // 只显示头尾几页和活跃页
          const shouldShow =
            idx < 2 ||
            idx >= allPages.length - 2 ||
            isActive ||
            Math.abs(page - pageRange.start) <= 1 ||
            Math.abs(page - pageRange.end) <= 1;

          if (!shouldShow && !showEllipsisBefore && !showEllipsisAfter) {
            // 用省略号替代
            if (idx === 2 && allPages.length > maxDisplay) {
              return (
                <span key={`ellipsis-${idx}`} className="text-muted-foreground px-1">
                  ...
                </span>
              );
            }
            return null;
          }

          return (
            <span key={page} className="flex items-center">
              {isFirstActive && <span className="text-muted-foreground">[</span>}
              <span
                className={cn(
                  "px-0.5",
                  isActive ? "text-foreground font-medium" : "text-muted-foreground",
                )}
              >
                {page}
              </span>
              {isLastActive && <span className="text-muted-foreground">]</span>}
              {idx < allPages.length - 1 && (
                <span className="text-muted-foreground">,</span>
              )}
            </span>
          );
        })}
      </div>
    );
  };

  return (
    <TooltipProvider>
      <nav
        role="navigation"
        aria-label="pagination"
        className={cn("flex items-center justify-center gap-2", className)}
      >
        {/* 上一组（更早的页面） */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={goToPrevGroup}
              disabled={!canGoPrev}
            >
              <ChevronLeftIcon className="h-4 w-4" />
              <span className="sr-only">上一组</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>查看更早的页面</TooltipContent>
        </Tooltip>

        {/* 页码指示器 */}
        {renderPageIndicator()}

        {/* 下一组（更新的页面） */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={goToNextGroup}
              disabled={!canGoNext}
            >
              <ChevronRightIcon className="h-4 w-4" />
              <span className="sr-only">下一组</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>查看更新的页面</TooltipContent>
        </Tooltip>

        {/* Pin/Unpin 切换 */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className={cn("h-8 w-8", state.pinned && "text-primary")}
              onClick={togglePin}
            >
              {state.pinned ? (
                <PinIcon className="h-4 w-4" />
              ) : (
                <PinOffIcon className="h-4 w-4" />
              )}
              <span className="sr-only">{state.pinned ? "取消锚定" : "锚定当前页"}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {state.pinned
              ? "取消锚定，新请求会自动滚动到最新页"
              : "锚定当前页，新请求不会自动滚动"}
          </TooltipContent>
        </Tooltip>

        {/* 显示页数信息 */}
        <span className="text-muted-foreground text-xs">
          显示 {pageRange.pages.length} 页 / 共 {totalPages} 页
        </span>
      </nav>
    </TooltipProvider>
  );
}
