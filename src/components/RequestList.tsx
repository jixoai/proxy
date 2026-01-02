import { useState, useEffect, useRef } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Inbox,
  Loader2,
  CheckCircle2,
  XCircle,
  Ban,
  Radio,
  Cable,
  Trash2,
  PlusCircle,
  ArrowRightCircle,
  Clock,
  Download,
  Plug,
  Heart,
  XOctagon,
} from "lucide-react";
import {
  useProxyViewer,
  type RequestData,
  type RequestStatus,
  type PluginInfo,
} from "@/components/ProxyViewerContext";
import { formatBytes, formatDuration, getMethodColor, getStatusClass } from "@/components/utils";
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
  MultiPagePagination,
  useMultiPagePagination,
} from "@/components/ui/multi-page-pagination";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AddForwardFromRequestDialog } from "@/components/AddForwardFromRequestDialog";
import { PluginUiBadge } from "@/components/PluginUiBadge";

const DEFAULT_PAGE_SIZE = 20;

// 状态徽章渲染
function StatusBadge({ status }: { status: RequestStatus }) {
  const configs = {
    pending: {
      variant: "secondary" as const,
      className: "bg-yellow-500/10 text-yellow-700 border-yellow-500/20 animate-pulse",
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
    aborted: {
      variant: "secondary" as const,
      className: "bg-orange-500/10 text-orange-700 border-orange-500/20",
      icon: Ban,
      label: "aborted",
    },
  };

  const config = configs[status];
  const Icon = config.icon;

  return (
    <Badge
      variant={config.variant}
      className={`flex items-center gap-1 text-xs ${config.className}`}
    >
      <Icon className="h-3 w-3" />
      <span>{config.label}</span>
    </Badge>
  );
}

// 插件标记渲染
function PluginBadge({ pluginInfo }: { pluginInfo?: PluginInfo }) {
  if (!pluginInfo) return null;

  const { pluginOrigin, pluginsProcessed, requestType } = pluginInfo;

  // 心跳请求特殊显示
  if (requestType === "ping") {
    return (
      <Tooltip>
        <TooltipTrigger>
          <Badge className="flex items-center gap-1 border-pink-500/20 bg-pink-500/10 text-xs text-pink-700">
            <Heart className="h-3 w-3" />
            <span>ping</span>
          </Badge>
        </TooltipTrigger>
        <TooltipContent>
          <div className="space-y-1 text-xs">
            <div>心跳请求 (cache keep-alive)</div>
            {pluginInfo.pingCount && <div>第 {pluginInfo.pingCount} 次心跳</div>}
            {pluginInfo.sessionId && (
              <div className="font-mono text-muted-foreground">
                Session: {pluginInfo.sessionId.slice(0, 8)}...
              </div>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    );
  }

  // 会话取消标记
  if (requestType === "session-cancelled") {
    return (
      <Tooltip>
        <TooltipTrigger>
          <Badge className="flex items-center gap-1 border-amber-500/20 bg-amber-500/10 text-xs text-amber-700">
            <XOctagon className="h-3 w-3" />
            <span>cancelled</span>
          </Badge>
        </TooltipTrigger>
        <TooltipContent>会话保活已取消</TooltipContent>
      </Tooltip>
    );
  }

  // 显示处理过的插件
  if (pluginsProcessed && pluginsProcessed.length > 0) {
    return (
      <Tooltip>
        <TooltipTrigger>
          <Badge className="flex items-center gap-1 border-cyan-500/20 bg-cyan-500/10 text-xs text-cyan-700">
            <Plug className="h-3 w-3" />
            <span>{pluginsProcessed.length}</span>
          </Badge>
        </TooltipTrigger>
        <TooltipContent>
          <div className="space-y-1 text-xs">
            <div className="font-medium">处理插件:</div>
            {pluginsProcessed.map((p) => (
              <div key={p} className="font-mono">
                {p}
              </div>
            ))}
          </div>
        </TooltipContent>
      </Tooltip>
    );
  }

  return null;
}

// 耗时显示组件
function DurationDisplay({
  status,
  timestamp,
  ttfbMs,
  bodyMs,
}: {
  status: RequestStatus;
  timestamp: string;
  ttfbMs?: number;
  bodyMs?: number;
}) {
  const [now, setNow] = useState(Date.now());

  // streaming/pending 状态下每秒更新
  useEffect(() => {
    if (status !== "streaming" && status !== "pending") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [status]);

  const startTime = new Date(timestamp).getTime();

  // pending: 等待响应头
  if (status === "pending") {
    const elapsed = now - startTime;
    return (
      <span className="flex items-center gap-1 text-yellow-600">
        <Clock className="h-3 w-3 animate-pulse" />
        <span>{formatDuration(elapsed)}</span>
      </span>
    );
  }

  // streaming: 收到响应头，等待 body 完成
  if (status === "streaming") {
    const bodyElapsed = ttfbMs !== undefined ? now - startTime - ttfbMs : 0;
    return (
      <span className="flex items-center gap-1 text-blue-600">
        <span>{formatDuration(ttfbMs ?? 0)}</span>
        <span>+</span>
        <Download className="h-3 w-3 animate-pulse" />
        <span>{formatDuration(bodyElapsed)}</span>
      </span>
    );
  }

  // completed/error: 显示最终时间
  if (ttfbMs !== undefined && bodyMs !== undefined) {
    return (
      <span className="flex items-center gap-1">
        <span>{formatDuration(ttfbMs)}</span>
        <span className="text-muted-foreground">+</span>
        <span>{formatDuration(bodyMs)}</span>
      </span>
    );
  }

  // fallback
  return <span>-</span>;
}

/** 判定为"新请求"的时间窗口（秒） */
const NEW_REQUEST_WINDOW_SEC = 10;

export function RequestList() {
  const {
    requests,
    totalCount,
    loading,
    pageLoading,
    pagesParam,
    setPagesParam,
    pageSize,
    loadPages,
    selectedId,
    selectRequest,
    deleteRequest,
    abortRequest,
    jumpToForwardRule,
    instances,
  } = useProxyViewer();

  // 跟踪当前右键菜单打开的行
  const [contextMenuOpenId, setContextMenuOpenId] = useState<string | null>(null);

  // 根据 instanceName 和 forwardId/forwardName 查找 forward 信息
  const getForwardInfo = (instanceName?: string, forwardName?: string, forwardId?: string) => {
    if (!instanceName || !forwardName) return null;
    const instance = instances.find((i) => i.name === instanceName);
    if (!instance) return null;
    // 优先使用 forwardId 精确匹配
    const forward = forwardId
      ? instance.forwards.find((f) => f.id === forwardId)
      : instance.forwards.find((f) => f.name === forwardName);
    return forward ? { name: forward.name, description: forward.description } : null;
  };

  // Pagination - 使用新的多页分页系统
  const itemsPerPage = pageSize || DEFAULT_PAGE_SIZE;
  const totalPages = Math.ceil(totalCount / itemsPerPage);
  const pagination = useMultiPagePagination({
    totalPages,
    pagesParam,
    onPagesChange: setPagesParam,
  });

  // 当页码范围变化时，加载对应页的数据
  const { pages: currentPages } = pagination.pageRange;
  const pagesKey = currentPages.join(",");
  const prevPagesKeyRef = useRef<string>("");
  const hasLoadedRef = useRef(false);
  
  useEffect(() => {
    // 只在以下情况触发加载：
    // 1. 页码变化（用户切换页面）
    // 2. 初次加载（hasLoaded=false 且 totalCount > 0）
    const pagesChanged = pagesKey !== prevPagesKeyRef.current;
    const needsInitialLoad = !hasLoadedRef.current && totalCount > 0 && currentPages.length > 0;
    const needsRefreshLoad = loading && totalCount > 0 && currentPages.length > 0;
    
    if (pagesChanged || needsInitialLoad || needsRefreshLoad) {
      prevPagesKeyRef.current = pagesKey;
      hasLoadedRef.current = true;
      loadPages(currentPages);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pagesKey, totalCount, loading]);

  const paginatedRequests = requests;
  const isFetching = loading || pageLoading;

  // 格式化时间戳
  const formatTimestamp = (timestamp: string) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  };

  const formatFullTimestamp = (timestamp: string) => {
    const date = new Date(timestamp);
    return date.toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      fractionalSecondDigits: 3,
    });
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* 顶部加载进度条（页面切换时显示） */}
      {pageLoading && (
        <div className="h-1 w-full bg-muted overflow-hidden">
          <div className="h-full bg-primary animate-pulse w-full" />
        </div>
      )}
      {/* Request Table */}
      <div className="flex-1 overflow-auto">
        {isFetching && paginatedRequests.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Loader2 className="animate-spin" />
              </EmptyMedia>
              <EmptyTitle>搜索中...</EmptyTitle>
              <EmptyDescription>正在获取请求记录</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : paginatedRequests.length === 0 ? (
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
                <TableHead className="w-16">#</TableHead>
                <TableHead className="w-20">时间</TableHead>
                <TableHead className="w-25">类型</TableHead>
                <TableHead className="w-30">状态</TableHead>
                <TableHead className="w-20">插件</TableHead>
                <TableHead className="w-20">响应码</TableHead>
                <TableHead className="min-w-60">路径</TableHead>
                <TableHead className="min-w-50">目标</TableHead>
                <TableHead className="w-25">请求体</TableHead>
                <TableHead className="w-25">响应体</TableHead>
                <TableHead className="w-20">耗时</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {paginatedRequests.map((req) => {
                const isRecent = Date.now() - new Date(req.metadata.timestamp).getTime() < NEW_REQUEST_WINDOW_SEC * 1000;
                return (
                <ContextMenu
                  key={req.id}
                  onOpenChange={(open) => setContextMenuOpenId(open ? req.id : null)}
                >
                  <ContextMenuTrigger asChild>
                    <TableRow
                      data-state={selectedId === req.id ? "selected" : undefined}
                      data-method={req.metadata.request.method}
                      onClick={() => selectRequest(req.id)}
                      className={`cursor-pointer ${contextMenuOpenId === req.id ? "bg-accent ring-2 ring-primary/50" : ""} ${isRecent ? "animate-highlight" : ""}`}
                    >
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {req.id}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        <Tooltip>
                          <TooltipTrigger>
                            {formatTimestamp(req.metadata.timestamp)}
                          </TooltipTrigger>
                          <TooltipContent>
                            {formatFullTimestamp(req.metadata.timestamp)}
                          </TooltipContent>
                        </Tooltip>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {req.metadata.isWebSocket ? (
                            <Badge className="flex items-center gap-1 border-purple-500/20 bg-purple-500/10 text-xs text-purple-700">
                              <Cable className="h-3 w-3" />
                              <span>WS</span>
                            </Badge>
                          ) : (
                            <Badge
                              className={`${getMethodColor(req.metadata.request.method)} border-0 text-xs text-white`}
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
                        <div className="space-y-1">
                          <PluginBadge pluginInfo={req.metadata.pluginInfo} />
                          {req.metadata.pluginUi?.records?.length ? (
                            <PluginUiBadge key={req.metadata.pluginUi.version} records={req.metadata.pluginUi.records} />
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell>
                        {req.metadata.response?.statusCode ? (
                          <Badge
                            variant={
                              getStatusClass(req.metadata.response.statusCode) === "success"
                                ? "default"
                                : getStatusClass(req.metadata.response.statusCode) === "redirect"
                                  ? "secondary"
                                  : "destructive"
                            }
                            className="text-xs"
                          >
                            {req.metadata.response.statusCode}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground text-xs">-</span>
                        )}
                      </TableCell>
                      <TableCell className="max-w-[250px] truncate font-mono text-xs">
                        <Tooltip>
                          <TooltipTrigger>
                            {new URL(req.metadata.request.url).pathname}
                          </TooltipTrigger>
                          <TooltipContent className="max-w-md">
                            {(() => {
                              const forwardInfo = getForwardInfo(
                                req.metadata.instanceName,
                                req.metadata.forwardName,
                                req.metadata.forwardId,
                              );
                              return forwardInfo ? (
                                <div className="space-y-1">
                                  <div className="font-medium">{forwardInfo.name}</div>
                                  {forwardInfo.description && (
                                    <div className="text-muted-foreground text-xs">
                                      {forwardInfo.description}
                                    </div>
                                  )}
                                  <div className="text-muted-foreground mt-1 border-t pt-1 font-mono text-xs">
                                    {req.metadata.request.url}
                                  </div>
                                </div>
                              ) : (
                                req.metadata.request.url
                              );
                            })()}
                          </TooltipContent>
                        </Tooltip>
                      </TableCell>
                      <TableCell className="max-w-[200px] truncate font-mono text-xs text-muted-foreground">
                        {req.metadata.targetUrl ? (
                          <Tooltip>
                            <TooltipTrigger>
                              {new URL(req.metadata.targetUrl).host}
                            </TooltipTrigger>
                            <TooltipContent>{req.metadata.targetUrl}</TooltipContent>
                          </Tooltip>
                        ) : (
                          "-"
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        {formatBytes(req.metadata.request.bodySize)}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        {req.metadata.status === "streaming" ? (
                          <span className="animate-pulse font-medium text-blue-600">
                            {formatBytes(req.metadata.response?.bodySize || 0)} ⚡
                          </span>
                        ) : (
                          formatBytes(req.metadata.response?.bodySize || 0)
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        <DurationDisplay
                          status={req.metadata.status}
                          timestamp={req.metadata.timestamp}
                          ttfbMs={req.metadata.ttfbMs}
                          bodyMs={req.metadata.bodyMs}
                        />
                      </TableCell>
                    </TableRow>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <AddForwardFromRequestDialog
                      request={req}
                      trigger={
                        <ContextMenuItem className="flex items-center gap-2">
                          <PlusCircle className="h-4 w-4" />
                          <span>添加到转发规则</span>
                        </ContextMenuItem>
                      }
                    />
                    <ContextMenuItem
                      disabled={!req.metadata.forwardName}
                      onSelect={() => {
                        const forwardName = req.metadata.forwardName;
                        if (forwardName) {
                          jumpToForwardRule(req.metadata.instanceName || "", forwardName);
                        }
                      }}
                      className="flex items-center gap-2"
                    >
                      <ArrowRightCircle className="h-4 w-4" />
                      <span>跳转到转发规则</span>
                    </ContextMenuItem>
                    {(req.metadata.status === "pending" || req.metadata.status === "streaming") && (
                      <ContextMenuItem
                        className="flex items-center gap-2 text-orange-600"
                        onSelect={() => abortRequest(req.id)}
                      >
                        <XCircle className="h-4 w-4" />
                        <span>中断请求</span>
                      </ContextMenuItem>
                    )}
                    <ContextMenuItem
                      className="text-destructive mt-1 flex items-center gap-2 border-t pt-1"
                      onSelect={() => deleteRequest(req.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                      <span>删除请求</span>
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              );
              })}
            </TableBody>
          </Table>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="border-t p-4">
          <MultiPagePagination pagination={pagination} />
        </div>
      )}
    </div>
  );
}
