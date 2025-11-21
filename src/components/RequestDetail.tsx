import { useMemo, useState } from "react";
import { useProxyViewer } from "@/components/ProxyViewerContext";
import { parseMarkdownHeaders } from "@/components/utils";
import { RequestBodyViewer } from "@/components/RequestBodyViewer";
import { ResponseBodyViewer } from "@/components/ResponseBodyViewer";
import { RequestInfoCard } from "@/components/RequestInfoCard";
import { ResponseInfoCard } from "@/components/ResponseInfoCard";
import { HeadersCard } from "@/components/HeadersCard";
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
import { generateFetchCode, generateNodeFetchCode, copyToClipboard } from "@/components/copy-as-fetch";
import { AddForwardFromRequestDialog } from "@/components/AddForwardFromRequestDialog";

export function RequestDetail() {
  const { selectedDetail, detailLoading, jumpToForwardRule } = useProxyViewer();
  const [copiedType, setCopiedType] = useState<string | null>(null); // 格式: "proxy-browser" | "origin-node" 等

  const requestHeaders = useMemo(() => {
    return selectedDetail?.requestContent
      ? parseMarkdownHeaders(selectedDetail.requestContent)
      : {};
  }, [selectedDetail]);

  const forwardedHeaders = useMemo(() => {
    return selectedDetail?.metadata?.forwardedHeaders || {};
  }, [selectedDetail]);

  const responseHeaders = useMemo(() => {
    return selectedDetail?.responseContent
      ? parseMarkdownHeaders(selectedDetail.responseContent)
      : {};
  }, [selectedDetail]);

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
      <div className="flex items-center justify-center h-full">
        <div className="text-muted-foreground">Loading detail...</div>
      </div>
    );
  }

  if (!selectedDetail) {
    return (
      <div className="flex items-center justify-center h-full">
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
      <div className="flex items-center gap-2 pb-2 border-b">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="flex items-center gap-2"
            >
              {copiedType ? (
                <CheckCheck className="w-4 h-4 text-green-600" />
              ) : (
                <Copy className="w-4 h-4" />
              )}
              <span>Copy</span>
              <ChevronDown className="w-4 h-4 ml-auto" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-48">
            <DropdownMenuItem onClick={() => handleCopyAsFetch("via-proxy")}>
              {copiedType === "via-proxy" ? (
                <CheckCheck className="w-4 h-4 mr-2 text-green-600" />
              ) : (
                <Copy className="w-4 h-4 mr-2" />
              )}
              <span>Copy via Proxy</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => handleCopyAsFetch("to-target")}>
              {copiedType === "to-target" ? (
                <CheckCheck className="w-4 h-4 mr-2 text-green-600" />
              ) : (
                <Copy className="w-4 h-4 mr-2" />
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
                  <PlusCircle className="w-4 h-4" />
                  <span>添加到转发规则</span>
                </Button>
              }
            />
            <Button
              variant="ghost"
              size="sm"
              className="flex items-center gap-1"
              disabled={!selectedDetail.metadata.forwardRule?.id}
              onClick={() => {
                const fr = selectedDetail.metadata.forwardRule;
                if (fr?.id) {
                  jumpToForwardRule(selectedDetail.metadata.instanceId, fr.id);
                }
              }}
            >
              <ArrowRightCircle className="w-4 h-4" />
              <span>跳转到转发规则</span>
            </Button>
          </>
        )}
      </div>

      {/* Request & Response Info - Two columns on wide screens */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <RequestInfoCard metadata={selectedDetail.metadata} />
        <ResponseInfoCard metadata={selectedDetail.metadata} />
      </div>

      {/* Request & Response Headers - Two columns on wide screens */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <HeadersCard
          title="Request Headers"
          headers={forwardedHeaders}
          originalHeaders={requestHeaders}
        />
        <HeadersCard title="Response Headers" headers={responseHeaders} />
      </div>

      {/* Request & Response Body - 使用容器查询实现响应式布局 */}
      <div className="@container">
        <div className="grid grid-cols-1 @[1280px]:grid-cols-2 gap-4">
          {/* Request Body - 只在有内容时显示 */}
          {selectedDetail.requestBody && (
            <RequestBodyViewer
              body={selectedDetail.requestBody}
              headers={requestHeaders}
            />
          )}

          {/* Response Body - 使用 ResponseBodyViewer 支持自动解压 */}
          <ResponseBodyViewer
            body={selectedDetail.responseBody || ""}
            headers={responseHeaders}
          />
        </div>
      </div>
    </div>
  );
}
