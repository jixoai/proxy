import * as React from "react";
import { ChevronLeftIcon, ChevronRightIcon, MoreHorizontalIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { UseMultiPagePaginationReturn } from "./useMultiPagePagination";

function MultiPagePaginationRoot({ className, ...props }: React.ComponentProps<"nav">) {
  return (
    <nav
      role="navigation"
      aria-label="multi-page pagination"
      data-slot="multi-page-pagination"
      className={cn("mx-auto flex w-full justify-center", className)}
      {...props}
    />
  );
}

function MultiPagePaginationContent({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul
      data-slot="multi-page-pagination-content"
      className={cn("flex flex-row items-center gap-1", className)}
      {...props}
    />
  );
}

function MultiPagePaginationItem({ ...props }: React.ComponentProps<"li">) {
  return <li data-slot="multi-page-pagination-item" {...props} />;
}

type MultiPagePaginationLinkProps = {
  isActive?: boolean;
  isAnchor?: boolean;
} & React.ComponentProps<"button">;

function MultiPagePaginationLink({
  className,
  isActive,
  isAnchor,
  ...props
}: MultiPagePaginationLinkProps) {
  return (
    <button
      type="button"
      aria-current={isAnchor ? "page" : undefined}
      data-slot="multi-page-pagination-link"
      data-active={isActive}
      data-anchor={isAnchor}
      className={cn(
        buttonVariants({
          variant: isAnchor ? "default" : isActive ? "outline" : "ghost",
          size: "icon",
        }),
        "size-9",
        className,
      )}
      {...props}
    />
  );
}

function MultiPagePaginationPrevious({
  className,
  ...props
}: React.ComponentProps<"button">) {
  return (
    <button
      type="button"
      aria-label="Go to previous group"
      data-slot="multi-page-pagination-previous"
      className={cn(
        buttonVariants({ variant: "ghost", size: "icon" }),
        "size-9",
        className,
      )}
      {...props}
    >
      <ChevronLeftIcon className="size-4" />
    </button>
  );
}

function MultiPagePaginationNext({
  className,
  ...props
}: React.ComponentProps<"button">) {
  return (
    <button
      type="button"
      aria-label="Go to next group"
      data-slot="multi-page-pagination-next"
      className={cn(
        buttonVariants({ variant: "ghost", size: "icon" }),
        "size-9",
        className,
      )}
      {...props}
    >
      <ChevronRightIcon className="size-4" />
    </button>
  );
}



function MultiPagePaginationEllipsis({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      aria-hidden
      data-slot="multi-page-pagination-ellipsis"
      className={cn("flex size-9 items-center justify-center", className)}
      {...props}
    >
      <MoreHorizontalIcon className="size-4" />
    </span>
  );
}

function MultiPagePaginationInfo({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="multi-page-pagination-info"
      className={cn("text-muted-foreground text-xs", className)}
      {...props}
    />
  );
}



export interface MultiPagePaginationProps {
  pagination: UseMultiPagePaginationReturn;
  className?: string;
}

/**
 * 多页分页组件
 *
 * 显示格式：< [4,3], 2, 1 > 表示当前显示第4和第3页
 */
function MultiPagePagination({ pagination, className }: MultiPagePaginationProps) {
  const {
    state,
    pageRange,
    totalPages,
    togglePin,
    setAnchor,
    goToPrevGroup,
    goToNextGroup,
    canGoPrev,
    canGoNext,
  } = pagination;

  if (totalPages <= 1) {
    return null;
  }

  const activePages = new Set(pageRange.pages);

  // 计算要显示的页码（带省略号）
  const maxVisible = Math.max(6, state.count * 2);
  const visiblePages: (number | "ellipsis-start" | "ellipsis-end")[] = [];

  if (totalPages <= maxVisible) {
    // 全部显示
    for (let i = totalPages; i >= 1; i--) {
      visiblePages.push(i);
    }
  } else {
    // 需要省略
    const rangeStart = pageRange.start;
    const rangeEnd = pageRange.end;

    // 始终显示最新页（totalPages）
    visiblePages.push(totalPages);

    // 计算活跃区域周围要显示的页码
    const buffer = Math.floor((maxVisible - 4) / 2); // 减去首尾2页和2个省略号位置
    const showStart = Math.max(rangeStart - buffer, 2);
    const showEnd = Math.min(rangeEnd + buffer, totalPages - 1);

    // 左侧省略号（如果需要）
    if (showEnd < totalPages - 1) {
      visiblePages.push("ellipsis-start");
    }

    // 中间页码（降序）
    for (let i = Math.min(showEnd, totalPages - 1); i >= Math.max(showStart, 2); i--) {
      visiblePages.push(i);
    }

    // 右侧省略号（如果需要）
    if (showStart > 2) {
      visiblePages.push("ellipsis-end");
    }

    // 始终显示最老页（1）
    if (totalPages > 1) {
      visiblePages.push(1);
    }
  }

  return (
    <MultiPagePaginationRoot className={className}>
      <MultiPagePaginationContent>
        {/* Pin toggle */}
        <MultiPagePaginationItem>
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-2">
                <Switch
                  id="pagination-pin"
                  checked={state.pinned}
                  onCheckedChange={togglePin}
                />
                <Label htmlFor="pagination-pin" className="text-muted-foreground text-xs cursor-pointer">
                  锚定
                </Label>
              </div>
            </TooltipTrigger>
            <TooltipContent>
              {state.pinned
                ? "取消锚定，新请求会自动滚动到最新页"
                : "锚定当前页，新请求不会自动滚动"}
            </TooltipContent>
          </Tooltip>
        </MultiPagePaginationItem>

        {/* 左箭头：向更新的页面（数字更大） */}
        <MultiPagePaginationItem>
          <Tooltip>
            <TooltipTrigger asChild>
              <MultiPagePaginationPrevious
                onClick={goToNextGroup}
                disabled={!canGoNext}
              />
            </TooltipTrigger>
            <TooltipContent>查看更新的页面</TooltipContent>
          </Tooltip>
        </MultiPagePaginationItem>

        {/* Page indicators */}
        {visiblePages.map((item, idx) => {
          if (item === "ellipsis-start" || item === "ellipsis-end") {
            return (
              <MultiPagePaginationItem key={item}>
                <MultiPagePaginationEllipsis />
              </MultiPagePaginationItem>
            );
          }
          const page = item;
          const isActive = activePages.has(page);
          const isAnchor = page === pageRange.end;

          return (
            <MultiPagePaginationItem key={page}>
              <MultiPagePaginationLink
                isActive={isActive}
                isAnchor={isAnchor}
                onClick={() => setAnchor(page)}
              >
                {page}
              </MultiPagePaginationLink>
            </MultiPagePaginationItem>
          );
        })}

        {/* 右箭头：向更早的页面（数字更小） */}
        <MultiPagePaginationItem>
          <Tooltip>
            <TooltipTrigger asChild>
              <MultiPagePaginationNext
                onClick={goToPrevGroup}
                disabled={!canGoPrev}
              />
            </TooltipTrigger>
            <TooltipContent>查看更早的页面</TooltipContent>
          </Tooltip>
        </MultiPagePaginationItem>

        {/* Info */}
        <MultiPagePaginationItem>
          <MultiPagePaginationInfo>
            显示 {pageRange.pages.length} 页 / 共 {totalPages} 页
          </MultiPagePaginationInfo>
        </MultiPagePaginationItem>
      </MultiPagePaginationContent>
    </MultiPagePaginationRoot>
  );
}

export {
  MultiPagePagination,
  MultiPagePaginationRoot,
  MultiPagePaginationContent,
  MultiPagePaginationItem,
  MultiPagePaginationLink,
  MultiPagePaginationPrevious,
  MultiPagePaginationNext,
  MultiPagePaginationEllipsis,
  MultiPagePaginationInfo,
};
