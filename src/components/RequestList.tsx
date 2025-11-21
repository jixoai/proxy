import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Inbox,
  Loader2,
  CheckCircle2,
  XCircle,
  Radio,
  Cable,
  Trash2,
  PlusCircle,
  ArrowRightCircle,
} from "lucide-react";
import {
  useProxyViewer,
  type RequestData,
  type RequestStatus,
} from "@/components/ProxyViewerContext";
import {
  formatBytes,
  getMethodColor,
  getStatusClass,
} from "@/components/utils";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationPrevious,
  PaginationNext,
} from "@/components/ui/pagination";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { AddForwardFromRequestDialog } from "@/components/AddForwardFromRequestDialog";

const ITEMS_PER_PAGE = 50;

// 状态徽章渲染
function StatusBadge({ status }: { status: RequestStatus }) {
  const configs = {
    pending: {
      variant: "secondary" as const,
      className:
        "bg-yellow-500/10 text-yellow-700 border-yellow-500/20 animate-pulse",
      icon: Loader2,
      label: "pending",
    },
    streaming: {
      variant: "secondary" as const,
      className: "bg-blue-500/10 text-blue-700 border-blue-500/20",
      icon: Radio,
      label: "streaming",
    },
    completed: {
      variant: "default" as const,
      className: "bg-green-500/10 text-green-700 border-green-500/20",
      icon: CheckCircle2,
      label: "completed",
    },
    error: {
      variant: "destructive" as const,
      className: "bg-red-500/10 text-red-700 border-red-500/20",
      icon: XCircle,
      label: "error",
    },
  };

  const config = configs[status];
  const Icon = config.icon;

  return (
    <Badge
      variant={config.variant}
      className={`text-xs flex items-center gap-1 ${config.className}`}
    >
      <Icon className="w-3 h-3" />
      <span>{config.label}</span>
    </Badge>
  );
}

export function RequestList() {
  const {
    requests,
    currentPage,
    setCurrentPage,
    filterMethod,
    filterStatus,
    filterUrl,
    selectedId,
    selectRequest,
    activeInstanceId,
    activeRuleId,
    deleteRequest,
    jumpToForwardRule,
  } = useProxyViewer();

  // 过滤后的请求
  const filteredRequests = useMemo(() => {
    return requests.filter((req) => {
      // 按实例过滤
      if (activeInstanceId !== null) {
        const reqInstanceId = req.metadata.instanceId;
        if (reqInstanceId !== activeInstanceId) {
          return false;
        }
      }

      // 按规则过滤
      if (activeRuleId !== null) {
        const ruleId = req.metadata.forwardRule?.id?.toString() || "unknown";
        if (ruleId !== activeRuleId) {
          return false;
        }
      }

      // 其他过滤条件
      if (filterMethod && req.metadata.request.method !== filterMethod) {
        return false;
      }
      if (filterStatus) {
        const statusCode = req.metadata.response?.statusCode?.toString() || "";
        if (statusCode !== filterStatus) {
          return false;
        }
      }
      if (
        filterUrl &&
        !req.metadata.request.url
          .toLowerCase()
          .includes(filterUrl.toLowerCase())
      ) {
        return false;
      }
      return true;
    });
  }, [
    requests,
    activeInstanceId,
    activeRuleId,
    filterMethod,
    filterStatus,
    filterUrl,
  ]);

  // Pagination
  const totalPages = Math.ceil(filteredRequests.length / ITEMS_PER_PAGE);
  const paginatedRequests = useMemo(() => {
    const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
    return filteredRequests.slice(startIndex, startIndex + ITEMS_PER_PAGE);
  }, [filteredRequests, currentPage]);

  // 格式化时间戳
  const formatTimestamp = (timestamp: string) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      fractionalSecondDigits: 3,
    });
  };

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Request Table */}
      <div className="flex-1 overflow-auto">
        {paginatedRequests.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Inbox />
              </EmptyMedia>
              <EmptyTitle>暂无请求记录</EmptyTitle>
              <EmptyDescription>等待代理服务器捕获请求</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-20">时间</TableHead>
                <TableHead className="w-25">类型</TableHead>
                <TableHead className="w-30">状态</TableHead>
                <TableHead className="w-20">响应码</TableHead>
                <TableHead className="min-w-75">路径</TableHead>
                <TableHead className="w-25">请求体</TableHead>
                <TableHead className="w-25">响应体</TableHead>
                <TableHead className="w-20">耗时</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {paginatedRequests.map((req) => (
                <ContextMenu key={req.id}>
                  <ContextMenuTrigger asChild>
                    <TableRow
                      data-state={
                        selectedId === req.id ? "selected" : undefined
                      }
                      onClick={() => selectRequest(req.id)}
                      className="cursor-pointer"
                    >
                      <TableCell className="font-mono text-xs">
                        {formatTimestamp(req.metadata.timestamp)}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {req.metadata.isWebSocket ? (
                            <Badge className="bg-purple-500/10 text-purple-700 border-purple-500/20 text-xs flex items-center gap-1">
                              <Cable className="w-3 h-3" />
                              <span>WS</span>
                            </Badge>
                          ) : (
                            <Badge
                              className={`${getMethodColor(req.metadata.request.method)} text-white border-0 text-xs`}
                            >
                              {req.metadata.request.method}
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={req.metadata.status} />
                      </TableCell>
                      <TableCell>
                        {req.metadata.response?.statusCode ? (
                          <Badge
                            variant={
                              getStatusClass(
                                req.metadata.response.statusCode,
                              ) === "success"
                                ? "default"
                                : getStatusClass(
                                      req.metadata.response.statusCode,
                                    ) === "redirect"
                                  ? "secondary"
                                  : "destructive"
                            }
                            className="text-xs"
                          >
                            {req.metadata.response.statusCode}
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            -
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs truncate max-w-[300px]">
                        <Tooltip>
                          <TooltipTrigger>
                            {new URL(req.metadata.request.url).pathname}
                          </TooltipTrigger>
                          <TooltipContent>
                            {req.metadata.request.url}
                          </TooltipContent>
                        </Tooltip>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {formatBytes(req.metadata.request.bodySize)}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {req.metadata.status === "streaming" ? (
                          <span className="text-blue-600 font-medium animate-pulse">
                            {formatBytes(req.metadata.response?.bodySize || 0)}{" "}
                            ⚡
                          </span>
                        ) : (
                          formatBytes(req.metadata.response?.bodySize || 0)
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {req.metadata.duration}
                      </TableCell>
                    </TableRow>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <AddForwardFromRequestDialog
                      request={req}
                      trigger={
                        <ContextMenuItem className="flex items-center gap-2">
                          <PlusCircle className="w-4 h-4" />
                          <span>添加到转发规则</span>
                        </ContextMenuItem>
                      }
                    />
                    <ContextMenuItem
                      disabled={!req.metadata.forwardRule?.id}
                      onClick={() => {
                        const fr = req.metadata.forwardRule;
                        if (fr?.id) {
                          jumpToForwardRule(
                            req.metadata.instanceId,
                            fr.id,
                          );
                        }
                      }}
                      className="flex items-center gap-2"
                    >
                      <ArrowRightCircle className="w-4 h-4" />
                      <span>跳转到转发规则</span>
                    </ContextMenuItem>
                    <ContextMenuItem className="border-t mt-1 pt-1 flex items-center gap-2 text-destructive"
                      onClick={() => deleteRequest(req.id)}
                    >
                      <Trash2 className="w-4 h-4" />
                      <span>删除请求</span>
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="border-t p-4">
          <Pagination>
            <PaginationContent>
              <PaginationItem>
                <PaginationPrevious
                  onClick={() => {
                    if (currentPage > 1) {
                      setCurrentPage((p: number) => p - 1);
                    }
                  }}
                  className={
                    currentPage === 1
                      ? "pointer-events-none opacity-50"
                      : "cursor-pointer"
                  }
                />
              </PaginationItem>
              <PaginationItem>
                <span className="text-sm text-muted-foreground px-4">
                  Page {currentPage} of {totalPages}
                </span>
              </PaginationItem>
              <PaginationItem>
                <PaginationNext
                  onClick={() => {
                    if (currentPage < totalPages) {
                      setCurrentPage((p: number) => p + 1);
                    }
                  }}
                  className={
                    currentPage === totalPages
                      ? "pointer-events-none opacity-50"
                      : "cursor-pointer"
                  }
                />
              </PaginationItem>
            </PaginationContent>
          </Pagination>
        </div>
      )}
    </div>
  );
}
