import { useMemo, useState } from "react";
import { useProxyViewer } from "@/components/ProxyViewerContext";
import type { HookLayer } from "@/components/ProxyViewerContext";
import { parseMarkdownHeaders } from "@/components/utils";
import { RequestBodyViewer } from "@/components/RequestBodyViewer";
import { ResponseBodyViewer } from "@/components/ResponseBodyViewer";
import { RequestInfoCard } from "@/components/RequestInfoCard";
import { ResponseInfoCard } from "@/components/ResponseInfoCard";
import { HeadersCard } from "@/components/HeadersCard";
import { HookLayersTabs } from "@/components/HookLayersTabs";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import {
  FileText,
  Copy,
  CheckCheck,
  ChevronDown,
  PlusCircle,
  ArrowRightCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import {
  generateFetchCode,
  generateNodeFetchCode,
  copyToClipboard,
} from "@/components/copy-as-fetch";
import { AddForwardFromRequestDialog } from "@/components/AddForwardFromRequestDialog";

export function RequestDetail() {
  const { selectedDetail, detailNotFound, detailLoading, selectRequest, jumpToForwardRule } = useProxyViewer();
  const [copiedType, setCopiedType] = useState<string | null>(null); // 格式: "proxy-browser" | "origin-node" 等

  const requestHeaders = useMemo(() => {
    return selectedDetail?.requestContent
      ? parseMarkdownHeaders(selectedDetail.requestContent)
      : {};
  }, [selectedDetail]);

  const forwardedHeaders = useMemo(() => {
    return selectedDetail?.metadata?.forwardedHeaders || {};
  }, [selectedDetail]);

  const hookedRequestHeaders = useMemo(() => {
    return selectedDetail?.hookedRequestContent
      ? parseMarkdownHeaders(selectedDetail.hookedRequestContent)
      : {};
  }, [selectedDetail]);

  const responseHeaders = useMemo(() => {
    return selectedDetail?.responseContent
      ? parseMarkdownHeaders(selectedDetail.responseContent)
      : {};
  }, [selectedDetail]);

  const hookedResponseHeaders = useMemo(() => {
    return selectedDetail?.hookedResponseContent
      ? parseMarkdownHeaders(selectedDetail.hookedResponseContent)
      : {};
  }, [selectedDetail]);

  const hasHookedRequest = selectedDetail?.metadata?.hasHookedRequest ?? false;
  const hasHookedResponse = selectedDetail?.metadata?.hasHookedResponse ?? false;
  const requestHookLayers = selectedDetail?.metadata?.requestHookLayers;
  const responseHookLayers = selectedDetail?.metadata?.responseHookLayers;

  // 复制为 fetch 代码
  const handleCopyAsFetch = async (mode: "via-proxy" | "to-target") => {
    if (!selectedDetail) return;
    const code = generateFetchCode(selectedDetail, mode);
    const success = await copyToClipboard(code);
    if (success) {
      setCopiedType(mode);
      setTimeout(() => setCopiedType(null), 2000);
    }
  };

  if (detailLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">Loading detail...</div>
      </div>
    );
  }

  if (detailNotFound) {
    return (
      <div className="flex h-full items-center justify-center">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FileText />
            </EmptyMedia>
            <EmptyTitle>请求不存在</EmptyTitle>
            <EmptyDescription>该请求记录可能已被删除或从未存在</EmptyDescription>
          </EmptyHeader>
          <Button variant="outline" onClick={() => selectRequest(null)}>
            返回列表
          </Button>
        </Empty>
      </div>
    );
  }

  if (!selectedDetail) {
    return (
      <div className="flex h-full items-center justify-center">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FileText />
            </EmptyMedia>
            <EmptyTitle>未选择请求</EmptyTitle>
            <EmptyDescription>从左侧列表选择一个请求查看详情</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Copy Actions */}
      <div className="flex items-center gap-2 border-b pb-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="flex items-center gap-2">
              {copiedType ? (
                <CheckCheck className="h-4 w-4 text-green-600" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
              <span>Copy</span>
              <ChevronDown className="ml-auto h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-48">
            <DropdownMenuItem onClick={() => handleCopyAsFetch("via-proxy")}>
              {copiedType === "via-proxy" ? (
                <CheckCheck className="mr-2 h-4 w-4 text-green-600" />
              ) : (
                <Copy className="mr-2 h-4 w-4" />
              )}
              <span>Copy via Proxy</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => handleCopyAsFetch("to-target")}>
              {copiedType === "to-target" ? (
                <CheckCheck className="mr-2 h-4 w-4 text-green-600" />
              ) : (
                <Copy className="mr-2 h-4 w-4" />
              )}
              <span>Copy to Target</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {selectedDetail && (
          <>
            <AddForwardFromRequestDialog
              request={selectedDetail}
              trigger={
                <Button variant="outline" size="sm" className="flex items-center gap-1">
                  <PlusCircle className="h-4 w-4" />
                  <span>添加到转发规则</span>
                </Button>
              }
            />
            <Button
              variant="ghost"
              size="sm"
              className="flex items-center gap-1"
              disabled={!selectedDetail.metadata.forwardName}
              onClick={() => {
                const forwardName = selectedDetail.metadata.forwardName;
                if (forwardName) {
                  jumpToForwardRule(selectedDetail.metadata.instanceName || "", forwardName);
                }
              }}
            >
              <ArrowRightCircle className="h-4 w-4" />
              <span>跳转到转发规则</span>
            </Button>
          </>
        )}
      </div>

      {/* Request & Response Info - Two columns on wide screens */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <RequestInfoCard metadata={selectedDetail.metadata} />
        <ResponseInfoCard metadata={selectedDetail.metadata} />
      </div>

      {/* Request & Response Headers - Two columns on wide screens */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <HookLayersTabs
          layers={requestHookLayers}
          hasHooked={hasHookedRequest}
          renderOriginal={() => (
            <HeadersCard
              title="Request Headers"
              headers={forwardedHeaders}
              originalHeaders={requestHeaders}
            />
          )}
          renderHooked={() => (
            <HeadersCard title="Request Headers (Hooked)" headers={hookedRequestHeaders} />
          )}
          renderLayer={(layer: HookLayer) => (
            <HeadersCard
              title={`Request Headers (${layer.pluginName})`}
              headers={layer.headers ? Object.fromEntries(
                Object.entries(layer.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : v])
              ) : {}}
            />
          )}
        />
        <HookLayersTabs
          layers={responseHookLayers}
          hasHooked={hasHookedResponse}
          renderOriginal={() => (
            <HeadersCard title="Response Headers" headers={responseHeaders} />
          )}
          renderHooked={() => (
            <HeadersCard title="Response Headers (Hooked)" headers={hookedResponseHeaders} />
          )}
          renderLayer={(layer: HookLayer) => (
            <HeadersCard
              title={`Response Headers (${layer.pluginName})`}
              headers={layer.headers ? Object.fromEntries(
                Object.entries(layer.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : v])
              ) : {}}
            />
          )}
        />
      </div>

      {/* Request & Response Body - 使用容器查询实现响应式布局 */}
      <div className="@container">
        <div className="grid grid-cols-1 gap-4 @[1280px]:grid-cols-2">
          {/* Request Body - 如果有 hookLayers 或 hooked 数据，使用 tabs */}
          {selectedDetail.requestBody && (
            <HookLayersTabs
              layers={requestHookLayers}
              hasHooked={hasHookedRequest}
              renderOriginal={() => (
                <RequestBodyViewer body={selectedDetail.requestBody!} headers={requestHeaders} />
              )}
              renderHooked={() => (
                <RequestBodyViewer
                  body={selectedDetail.hookedRequestBody || selectedDetail.requestBody!}
                  headers={hookedRequestHeaders}
                />
              )}
              renderLayer={(layer: HookLayer) => (
                <RequestBodyViewer
                  body={layer.bodyDataUrl || ""}
                  headers={layer.headers ? Object.fromEntries(
                    Object.entries(layer.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : v])
                  ) : {}}
                />
              )}
            />
          )}

          {/* Response Body - 如果有 hookLayers 或 hooked 数据，使用 tabs */}
          <HookLayersTabs
            layers={responseHookLayers}
            hasHooked={hasHookedResponse}
            renderOriginal={() => (
              <ResponseBodyViewer body={selectedDetail.responseBody || ""} headers={responseHeaders} />
            )}
            renderHooked={() => (
              <ResponseBodyViewer
                body={selectedDetail.hookedResponseBody || ""}
                headers={hookedResponseHeaders}
              />
            )}
            renderLayer={(layer: HookLayer) => (
              <ResponseBodyViewer
                body={layer.bodyDataUrl || ""}
                headers={layer.headers ? Object.fromEntries(
                  Object.entries(layer.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : v])
                ) : {}}
              />
            )}
          />
        </div>
      </div>
    </div>
  );
}
